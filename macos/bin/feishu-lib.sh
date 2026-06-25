#!/bin/bash
# feishu-lib.sh — 飞书<->Claude Code 多 bot 桥接共享库。其它脚本 `source` 它。
#
# 约定(全局):
#   注册表        : ~/.lark-cli/daemon/bot-registry.json   (不进 git;密钥/chat_id 只在这里)
#   每 bot 事件日志: ~/Library/Logs/feishu/<bot>.log  (stderr: <bot>.err)   ← 持久目录,不在 /tmp
#                   (兼容: keepalive 另建 /tmp/feishu-<bot>.{log,err} 软链给老 session/旧文档读)
#   每 bot launchd : com.frank.feishu.<bot>  →  ~/Library/LaunchAgents/com.frank.feishu.<bot>.plist
#   每 bot 重启标记: /tmp/feishu-<bot>.started.marker  (故意留 /tmp:reboot 清空→首启静默)
#   per-session 绑定: ~/.lark-cli/daemon/binding-<claude_pid>.json
#   notify 去重    : /tmp/feishu-notify-once/<chat>.<tag>.last
#
# 铁律(从 ~/.claude/CLAUDE.md 继承):
#   - 绝不 --force;绝不在 session 内起 +subscribe(launchd 独占);绝不 arm 5 分钟巡检 cron。
#   - session 内的 Monitor 只能 tail 日志。
#   - 出站发消息没有"默认 bot":解析不到 bot 就不发,改为问用户。
set -u

# ── 可移植的 node/lark-cli 定位 ────────────────────────────────────────────────
# launchd 跑 job 时 PATH 极简(/usr/bin:/bin),找不到 nvm/homebrew 装的 lark-cli/node。
# 这里动态定位「含 lark-cli 的 bin 目录」并塞进 PATH。优先级:
#   FEISHU_NODE_BIN 环境变量(显式覆盖) → 当前 PATH 上的 lark-cli → 最新 nvm node → homebrew → /usr/local
# feishu-install-agent.sh 会读 $FEISHU_NODE_BIN 写进 launchd plist 的 PATH,故无需硬编码用户名/版本。
FEISHU_NODE_BIN="${FEISHU_NODE_BIN:-}"
if [ -z "$FEISHU_NODE_BIN" ]; then
  _lc="$(command -v lark-cli 2>/dev/null || true)"
  [ -n "$_lc" ] && FEISHU_NODE_BIN="$(cd "$(dirname "$_lc")" 2>/dev/null && pwd)"
fi
if [ -z "$FEISHU_NODE_BIN" ]; then
  for _c in $(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -Vr) /opt/homebrew/bin /usr/local/bin; do
    [ -x "$_c/lark-cli" ] && { FEISHU_NODE_BIN="$_c"; break; }
  done
fi
export FEISHU_NODE_BIN
export PATH="${FEISHU_NODE_BIN:+$FEISHU_NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export LARK_CLI_NO_PROXY=1   # 直连飞书,绕过本机代理(防止凭据走代理 / WebSocket 被劫持)

FEISHU_DAEMON_DIR="$HOME/.lark-cli/daemon"
FEISHU_REGISTRY="$FEISHU_DAEMON_DIR/bot-registry.json"
FEISHU_DEDUP_DIR="/tmp/feishu-notify-once"
# 事件日志放持久目录,绝不放 /tmp:/tmp 会被系统周期清理 / reboot 清空。空闲 bot 的日志一旦被
# unlink,订阅进程会继续往那个"幽灵 inode"写,新消息在路径上看不到 = 等于被吞(2026-06-08
# macmini 真踩过)。~/Library/Logs 永不被自动清理、文件永不被 unlink,从根上杜绝丢消息。
FEISHU_LOGDIR="$HOME/Library/Logs/feishu"
JQ="$(command -v jq || echo /usr/bin/jq)"

feishu_log_path()     { echo "$FEISHU_LOGDIR/$1.log"; }
feishu_err_path()     { echo "$FEISHU_LOGDIR/$1.err"; }
# marker 仍留 /tmp(故意):reboot 清空 → 重启后首启视为"首次"、不发"自动重启"通知(预期行为)。
feishu_marker_path()  { echo "/tmp/feishu-$1.started.marker"; }
feishu_label()        { echo "com.frank.feishu.$1"; }
feishu_plist_path()   { echo "$HOME/Library/LaunchAgents/com.frank.feishu.$1.plist"; }
feishu_binding_path() { echo "$FEISHU_DAEMON_DIR/binding-${1:-$PPID}.json"; }

# 读某 bot 的字段;不存在则空串 + 非零返回
feishu_bot_field() { # <bot> <field>
  [ -f "$FEISHU_REGISTRY" ] || return 2
  "$JQ" -er --arg b "$1" --arg f "$2" '.bots[$b][$f] // empty' "$FEISHU_REGISTRY" 2>/dev/null
}

feishu_bot_exists() { # <bot>
  [ -f "$FEISHU_REGISTRY" ] || return 2
  "$JQ" -e --arg b "$1" '.bots[$b]' "$FEISHU_REGISTRY" >/dev/null 2>&1
}

feishu_bot_enabled() { # <bot> -> rc 0 当且仅当 enabled==true
  [ -f "$FEISHU_REGISTRY" ] || return 2
  "$JQ" -e --arg b "$1" '(.bots[$b].enabled // false) == true' "$FEISHU_REGISTRY" >/dev/null 2>&1
}

# 列出所有 enabled=true 的 bot 名(每行一个)
feishu_list_enabled_bots() {
  [ -f "$FEISHU_REGISTRY" ] || return 0
  "$JQ" -r '(.bots // {}) | to_entries[] | select(.value.enabled==true) | .key' "$FEISHU_REGISTRY" 2>/dev/null
}

# 出站路由:FEISHU_BOT 环境变量 → 按项目目录匹配 → (无 default!) 解析不到返回 1。
# 成功时把 bot 名 echo 到 stdout。调用方解析不到时绝不能擅自发消息,要问用户。
feishu_resolve_bot() {
  # 只解析到 enabled 的 bot;disabled 的(如离线的 bot1)即使 env 指定也不解析。
  if [ -n "${FEISHU_BOT:-}" ] && feishu_bot_exists "$FEISHU_BOT" && feishu_bot_enabled "$FEISHU_BOT"; then
    echo "$FEISHU_BOT"; return 0
  fi
  local dir="${CLAUDE_PROJECT_DIR:-$PWD}" m
  m="$("$JQ" -r --arg d "$dir" \
      '. as $root | ((.projects // [])[]
        | select((.match_dir_contains // "") as $s | ($s|length>0) and ($d|contains($s)))
        | .bot | select(($root.bots[.].enabled // false) == true)) // empty' \
      "$FEISHU_REGISTRY" 2>/dev/null | head -1)"
  if [ -n "$m" ] && [ "$m" != "null" ]; then echo "$m"; return 0; fi
  return 1   # 没有默认 bot —— 由调用方"问用户要不要连飞书",绝不擅自发
}

# 解析 lark-cli 可执行
feishu_larkcli() { command -v lark-cli 2>/dev/null || echo "${FEISHU_NODE_BIN:+$FEISHU_NODE_BIN/}lark-cli"; }
