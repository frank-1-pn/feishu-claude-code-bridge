#!/bin/bash
# feishu-mem-install.sh <bot> — 装/重装一个 launchd tailer,把该 bot 的飞书入站消息
# 捕获进 claude-mem(project=feishu-<bot>)。独立 label com.frank.feishu-mem.<bot>,
# 只读 ~/Library/Logs/feishu/<bot>.log,**绝不碰 com.frank.feishu.<bot> 订阅连接**。幂等。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/feishu-lib.sh"

BOT="${1:?usage: feishu-mem-install.sh <bot>}"
feishu_bot_exists "$BOT" || { echo "未知 bot: $BOT (先加进注册表)" >&2; exit 78; }

LABEL="com.frank.feishu-mem.$BOT"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TAILER="$DIR/feishu-mem-tailer.sh"
GUI="gui/$(id -u)"
chmod +x "$TAILER" "$DIR/feishu-mem-poster.py" 2>/dev/null || true
mkdir -p "$FEISHU_LOGDIR"   # launchd 打开 StandardOutPath 前其父目录必须存在

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$TAILER</string>
        <string>$BOT</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$FEISHU_LOGDIR/mem-$BOT.log</string>
    <key>StandardErrorPath</key>
    <string>$FEISHU_LOGDIR/mem-$BOT.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/local/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>CLAUDE_MEM_URL</key>
        <string>http://127.0.0.1:37701</string>
    </dict>
</dict>
</plist>
PLIST
echo "✓ 写入 plist: $PLIST"

# 幂等重装: bootout 后轮询到彻底卸载,再带重试 bootstrap
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
sleep 2
echo "── launchd 状态 ──"
launchctl print "$GUI/$LABEL" 2>&1 | grep -E "state =|pid =|last exit" | head -4
