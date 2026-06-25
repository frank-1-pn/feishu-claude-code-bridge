#!/bin/bash
# feishu-keepalive.sh <bot> — launchd 启动的 per-bot 看门狗 wrapper。
#
# 读注册表拿该 bot 的 profile/event_types/as/chat_id;若已有重启标记且 notify_on_restart=true,
# 先给该 bot 自己的 chat 发一条"自动重启"通知(首次启动静默);然后 exec
#   lark-cli event +subscribe --profile <p> --event-types <e> --compact --as <as>
# 事件写 stdout(launchd 把 stdout 重定向到 ~/Library/Logs/feishu/<bot>.log,stderr 到 .err)。
#
# 注意: 本脚本由 launchd 独占运行。session 永远不要直接跑它,也不要跑 +subscribe。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/feishu-lib.sh"

BOT="${1:?usage: feishu-keepalive.sh <bot>}"
feishu_bot_exists "$BOT" || { echo "[keepalive] 未知 bot: $BOT (不在注册表)" >&2; exit 78; }

PROFILE="$(feishu_bot_field "$BOT" profile 2>/dev/null || true)"
[ -z "$PROFILE" ] && PROFILE="$(feishu_bot_field "$BOT" app_id 2>/dev/null || true)"
EVENTS="$(feishu_bot_field "$BOT" event_types 2>/dev/null || true)";  [ -z "$EVENTS" ] && EVENTS="im.message.receive_v1"
ASTYPE="$(feishu_bot_field "$BOT" as 2>/dev/null || true)";           [ -z "$ASTYPE" ] && ASTYPE="bot"
CHAT="$(feishu_bot_field "$BOT" chat_id 2>/dev/null || true)"
NOTIFY="$(feishu_bot_field "$BOT" notify_on_restart 2>/dev/null || true)"
MARKER="$(feishu_marker_path "$BOT")"
LARK="$(feishu_larkcli)"

if [ -z "$PROFILE" ]; then echo "[keepalive] bot $BOT 缺 profile/app_id" >&2; exit 78; fi

# 重启通知: 首次启动(无 marker)静默;之后每次 launchd 重启发一条。
if [ -f "$MARKER" ] && [ "$NOTIFY" = "true" ] && [ -n "$CHAT" ]; then
  "$LARK" im +messages-send --profile "$PROFILE" --chat-id "$CHAT" \
    --text "launchd 自动重启飞书连接(bot=$BOT)" --as "$ASTYPE" >/dev/null 2>&1 || true
fi
touch "$MARKER"

# 持久日志目录(launchd 已用它做 StandardOutPath;此处防御性确保存在)+ /tmp 兼容软链。
# 真实数据始终写在持久目录;/tmp 软链只为兼容老 session/旧文档的 `tail /tmp/feishu-<bot>.log`,
# 每次启动重建一次(被 /tmp 清理也能自愈;软链丢了也不丢消息,因为真实文件在持久目录)。
mkdir -p "$FEISHU_LOGDIR" 2>/dev/null || true
ln -sf "$(feishu_log_path "$BOT")" "/tmp/feishu-$BOT.log" 2>/dev/null || true
ln -sf "$(feishu_err_path "$BOT")" "/tmp/feishu-$BOT.err" 2>/dev/null || true

echo "[keepalive] $(date '+%F %T') 启动 subscribe: bot=$BOT profile=$PROFILE events=$EVENTS as=$ASTYPE" >&2
exec "$LARK" event +subscribe --profile "$PROFILE" --event-types "$EVENTS" --compact --as "$ASTYPE"
