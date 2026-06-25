#!/bin/bash
# install.sh — 在一台新 Mac 上安装 Feishu <-> Claude Code 多 bot 桥接「框架」。
#
# 做什么(全是机械、幂等的安全操作):
#   1. 体检 prereqs(macOS / jq / lark-cli)
#   2. 把 bin/ 脚本拷到 ~/.claude/bin/feishu/
#   3. 建 ~/Library/Logs/feishu/(持久日志)与 ~/.lark-cli/daemon/
#   4. 若无注册表则种子化一个空注册表
#   5. 打印「加第一个 bot」的下一步命令
#
# 不做什么:不写任何密钥、不替你 `profile add`、不替你加 bot、不动 launchd。
# 密钥(app_secret)必须由你自己经 stdin 录进 keychain —— 见结尾打印的步骤。
set -euo pipefail

REPO_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/bin" && pwd)"
DEST="$HOME/.claude/bin/feishu"
DAEMON="$HOME/.lark-cli/daemon"
LOGDIR="$HOME/Library/Logs/feishu"
REG="$DAEMON/bot-registry.json"

say(){ printf '%s\n' "$*"; }
hr(){ printf '%s\n' "────────────────────────────────────────────────"; }

hr; say "Feishu <-> Claude Code 多 bot 桥接 · 安装 (macOS)"; hr

# 1) 体检 ---------------------------------------------------------------------
[ "$(uname)" = "Darwin" ] || { echo "✗ 本桥接只支持 macOS(launchd)。"; exit 1; }

if command -v jq >/dev/null 2>&1; then say "✓ jq: $(command -v jq)"
else say "⚠️  未找到 jq —— 注册表读写需要它。装:  brew install jq"; fi

if LARK="$(command -v lark-cli 2>/dev/null)"; then
  say "✓ lark-cli: $LARK"
else
  say "⚠️  未找到 lark-cli。先安装(例: npm i -g @larksuite/cli),确认 \`lark-cli --version\` 可用后再重跑本脚本。"
fi

# 2) 拷脚本 -------------------------------------------------------------------
mkdir -p "$DEST"
cp "$REPO_BIN"/*.sh "$REPO_BIN"/*.py "$DEST"/
chmod +x "$DEST"/*.sh "$DEST"/*.py
say "✓ 脚本已装到 $DEST"

# 3) 目录 ---------------------------------------------------------------------
mkdir -p "$DAEMON" "$LOGDIR"
say "✓ 持久日志目录 $LOGDIR"
say "✓ daemon 目录   $DAEMON"

# 4) 种子注册表(绝不覆盖已有)-------------------------------------------------
if [ -f "$REG" ]; then
  say "✓ 已存在注册表 $REG(保留,不覆盖)"
else
  printf '{\n  "bots": {},\n  "projects": [],\n  "default": null\n}\n' > "$REG"
  say "✓ 已创建空注册表 $REG"
fi

# 5) 下一步 -------------------------------------------------------------------
hr; say "下一步:加第一个 bot(密钥只走 stdin,绝不进文件/命令行历史)"; hr
cat <<EOF
① 把该 app 的 secret 录进 keychain:
   printf '%s' '<APP_SECRET>' | lark-cli profile add \\
       --app-id cli_xxx --name cli_xxx --app-secret-stdin --brand feishu

② 拿 chat_id:让该 bot 给你发一条消息(或在飞书开发者后台查),然后登记 + 装 launchd 看门狗:
   $DEST/feishu-add-bot.sh <名字> cli_xxx <chat_id> [别名]

③ 体检 + 看本 session 该连哪个 bot:
   $DEST/feishu-ensure.sh

④ 在 Claude Code 会话里 arm 事件桥接(否则消息进日志但 Claude 收不到):
   Monitor:  tail -n 0 -F ~/Library/Logs/feishu/<名字>.log

(可选) 把入站消息捕获进 claude-mem(需本机已装并运行 claude-mem):
   $DEST/feishu-mem-install.sh <名字>

完整说明:  macos/docs/SETUP.md(新机配置) · macos/docs/MULTI-BOT.md(多 bot 管理)
机制/排错:  macos/docs/ARCHITECTURE.md(§7 排错手册)
EOF
hr; say "框架安装完成。Bot 需要你按上面 ①–④ 手动加(因为要录密钥)。"; hr
