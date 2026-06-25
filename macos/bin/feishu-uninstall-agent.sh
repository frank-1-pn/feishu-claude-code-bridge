#!/bin/bash
# feishu-uninstall-agent.sh <bot> — bootout 并删除某 bot 的 launchd plist(不动注册表)。
# 想彻底下线某 bot: 跑本脚本 + 把注册表里该 bot 的 enabled 设为 false(或删条目)。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/feishu-lib.sh"

BOT="${1:?usage: feishu-uninstall-agent.sh <bot>}"
LABEL="$(feishu_label "$BOT")"; PLIST="$(feishu_plist_path "$BOT")"; GUI="gui/$(id -u)"

if launchctl bootout "$GUI/$LABEL" 2>/dev/null; then echo "✓ booted out $LABEL"; else echo "(未加载 $LABEL)"; fi
sleep 1
if [ -f "$PLIST" ]; then rm -f "$PLIST" && echo "✓ removed $PLIST"; fi
ps aux | grep -v grep | grep "event +subscribe" | grep -- "--profile $(feishu_bot_field "$BOT" profile 2>/dev/null || feishu_bot_field "$BOT" app_id 2>/dev/null)" \
  && echo "⚠️ 仍有该 profile 的 subscribe 进程,可能 launchd 正在 throttle 重启" || echo "✓ 无残留 subscribe 进程"
echo "注意: 注册表条目仍在(enabled 仍为 true)。彻底移除请改 bot-registry.json。"
