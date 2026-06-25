#!/bin/bash
# feishu-install-agent.sh <bot> — 为某 bot 生成 launchd plist 并(重新)bootstrap。
# 幂等: 已加载则先 bootout 再装。会真正把该 bot 连上飞书(launchd KeepAlive 看门狗)。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/feishu-lib.sh"

BOT="${1:?usage: feishu-install-agent.sh <bot>}"
feishu_bot_exists "$BOT" || { echo "未知 bot: $BOT (先加进注册表)" >&2; exit 78; }

LABEL="$(feishu_label "$BOT")"
PLIST="$(feishu_plist_path "$BOT")"
LOG="$(feishu_log_path "$BOT")"
ERR="$(feishu_err_path "$BOT")"
KEEPALIVE="$DIR/feishu-keepalive.sh"
GUI="gui/$(id -u)"

# launchd 打开 StandardOutPath/ErrorPath 前其父目录必须已存在,否则 job 起不来 → 先建持久日志目录
mkdir -p "$FEISHU_LOGDIR"

[ -x "$KEEPALIVE" ] || chmod +x "$KEEPALIVE"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$KEEPALIVE</string>
        <string>$BOT</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$ERR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${FEISHU_NODE_BIN:+$FEISHU_NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>LARK_CLI_NO_PROXY</key>
        <string>1</string>
    </dict>
</dict>
</plist>
PLIST
echo "✓ 写入 plist: $PLIST"

# 幂等重装: bootout 后轮询到彻底卸载,再带重试 bootstrap(避开 launchd 异步 teardown 竞态)
if launchctl print "$GUI/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$GUI/$LABEL" 2>/dev/null && echo "  (已 bootout 旧实例)"
  for _ in $(seq 1 20); do
    launchctl print "$GUI/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done
fi
BS_OK=0
for _ in $(seq 1 3); do
  if launchctl bootstrap "$GUI" "$PLIST"; then BS_OK=1; break; fi
  sleep 1
done
if [ "$BS_OK" = 1 ]; then echo "✓ bootstrap $LABEL"; else echo "✗ bootstrap 失败: $LABEL" >&2; exit 1; fi
sleep 3
echo "── launchd 状态 ──"
launchctl print "$GUI/$LABEL" 2>&1 | grep -E "state =|pid =|last exit" | head -4
echo "── subscribe 进程 ──"
ps aux | grep -v grep | grep "event +subscribe" | grep -- "--profile $(feishu_bot_field "$BOT" profile 2>/dev/null || feishu_bot_field "$BOT" app_id)" || echo "(尚未出现,可能还在启动)"
