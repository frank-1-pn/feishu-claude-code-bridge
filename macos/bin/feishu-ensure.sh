#!/bin/bash
# feishu-ensure.sh — session 启动健康检查 + 轻量 housekeeping(只读为主)。
#   • 打印每个 enabled bot 的 launchd 看门狗状态 + 日志情况
#   • 打印本 session 解析到的 bot(env / 项目目录),或提示"未绑定,需要时问用户"
#   • 清理 >7 天的 notify 去重锁
#   不 arm tail(Monitor 由 Claude 决定/问用户),不起 +subscribe,不 --force。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/feishu-lib.sh"
GUI="gui/$(id -u)"

echo "===== 飞书多 bot 健康检查 ($(date '+%F %T')) ====="
BOTS="$(feishu_list_enabled_bots)"
[ -z "$BOTS" ] && echo "(注册表里没有 enabled 的 bot)"
for bot in $BOTS; do
  LABEL="$(feishu_label "$bot")"; LOG="$(feishu_log_path "$bot")"; PLIST="$(feishu_plist_path "$bot")"
  ALIAS="$(feishu_bot_field "$bot" alias 2>/dev/null || echo "$bot")"
  STATE="$(launchctl print "$GUI/$LABEL" 2>/dev/null | awk -F'= ' '/[^a-z]state =/{gsub(/ /,"",$2);print $2; exit}')"
  PID="$(launchctl print "$GUI/$LABEL" 2>/dev/null | awk -F'= ' '/pid =/{gsub(/ /,"",$2);print $2; exit}')"
  [ -f "$PLIST" ] && PL="plist✓" || PL="plist✗"
  if [ -f "$LOG" ]; then SZ="$(wc -c < "$LOG" | tr -d ' ')B"; else SZ="无日志"; fi
  printf "  • %-6s (%s) launchd=%s pid=%s %s log=%s\n" "$bot" "$ALIAS" "${STATE:-未加载}" "${PID:-?}" "$PL" "$SZ"
done

# housekeeping: 清理 >7 天去重锁
if [ -d "$FEISHU_DEDUP_DIR" ]; then
  N="$(find "$FEISHU_DEDUP_DIR" -type f -mtime +7 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${N:-0}" -gt 0 ]; then find "$FEISHU_DEDUP_DIR" -type f -mtime +7 -delete 2>/dev/null; echo "  housekeeping: 清理了 $N 个过期去重锁"; fi
fi

# 本 session 绑定
if RB="$(feishu_resolve_bot)"; then
  SRC="项目目录匹配"; [ -n "${FEISHU_BOT:-}" ] && SRC="环境变量 FEISHU_BOT"
  echo "本 session 绑定 bot = $RB(来源: $SRC)→ arm Monitor: $DIR/feishu-tail.sh $RB  (过滤卡键乱码 + message_id 去重,免日志重放刷屏)"
else
  echo "本 session 未绑定 bot(无 FEISHU_BOT、无项目匹配)→ 需要发飞书时,先问用户要不要连、连哪个 bot。"
fi
