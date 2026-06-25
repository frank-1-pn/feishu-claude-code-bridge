#!/bin/bash
# feishu-notify.sh — 出站发消息(带去重)。
#   --auto-bot          自动解析 bot: FEISHU_BOT 环境变量 → 项目目录匹配 → 无则不发(退出码 3)
#   --bot <name>        指定 bot(优先于 --auto-bot)
#   --text <msg>        纯文本   | --markdown <md>  markdown
#   --chat-id <id>      覆盖该 bot 默认 chat(默认用注册表 chat_id)
#   --tag <tag>         去重标签(默认 default)   | --window <secs> 去重窗口(默认 30)
#
# 铁律: 解析不到 bot 绝不发消息,退出码 3。hook 应静默跳过;Claude 应改为问用户要不要连飞书。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/feishu-lib.sh"

BOT=""; AUTO=0; TEXT=""; MD=""; CHAT_OVERRIDE=""; TAG="default"; WINDOW=30
# 注意: 每个带值的 flag 必须先 [ $# -ge 2 ] 守卫再 shift 2。
# 否则 macOS bash 3.2 下 `shift 2`(仅剩 1 个参数时)是 no-op → while 循环死转 100% CPU。
while [ $# -gt 0 ]; do
  case "$1" in
    --auto-bot) AUTO=1; shift;;
    --bot|--text|--markdown|--chat-id|--tag|--window)
      [ $# -ge 2 ] || { echo "[notify] $1 需要一个参数" >&2; exit 64; }
      case "$1" in
        --bot) BOT="$2";; --text) TEXT="$2";; --markdown) MD="$2";;
        --chat-id) CHAT_OVERRIDE="$2";; --tag) TAG="$2";; --window) WINDOW="$2";;
      esac
      shift 2;;
    *) echo "[notify] 未知参数: $1" >&2; exit 64;;
  esac
done
case "$WINDOW" in ''|*[!0-9]*) echo "[notify] --window 需为非负整数: $WINDOW" >&2; exit 64;; esac

if [ -z "$BOT" ] && [ "$AUTO" = "1" ]; then BOT="$(feishu_resolve_bot || true)"; fi
if [ -z "$BOT" ]; then
  echo "[notify] 解析不到 bot(无 --bot / FEISHU_BOT / 项目匹配)→ 按规则不发消息(应问用户)。" >&2
  exit 3
fi
feishu_bot_exists "$BOT" || { echo "[notify] 未知 bot: $BOT" >&2; exit 78; }

PROFILE="$(feishu_bot_field "$BOT" profile 2>/dev/null || true)"; [ -z "$PROFILE" ] && PROFILE="$(feishu_bot_field "$BOT" app_id)"
ASTYPE="$(feishu_bot_field "$BOT" as 2>/dev/null || true)"; [ -z "$ASTYPE" ] && ASTYPE="bot"
CHAT="$CHAT_OVERRIDE"; [ -z "$CHAT" ] && CHAT="$(feishu_bot_field "$BOT" chat_id 2>/dev/null || true)"
[ -z "$CHAT" ] && { echo "[notify] bot $BOT 无 chat_id 且未提供 --chat-id" >&2; exit 65; }
[ -z "$TEXT$MD" ] && { echo "[notify] 缺 --text / --markdown" >&2; exit 64; }
LARK="$(feishu_larkcli)"

# 去重: key = chat + tag,窗口内只发一次
mkdir -p "$FEISHU_DEDUP_DIR"
SAFE="$(printf '%s.%s' "$CHAT" "$TAG" | tr -c 'A-Za-z0-9._-' '_')"
LASTF="$FEISHU_DEDUP_DIR/$SAFE.last"
NOW="$(date +%s)"
if [ -f "$LASTF" ]; then
  LAST="$(cat "$LASTF" 2>/dev/null || echo 0)"
  if [ $((NOW - LAST)) -lt "$WINDOW" ]; then
    echo "[notify] 去重跳过(tag=$TAG chat=$CHAT,${WINDOW}s 内已发)" >&2; exit 0
  fi
fi

if [ -n "$MD" ]; then
  "$LARK" im +messages-send --profile "$PROFILE" --chat-id "$CHAT" --markdown "$MD" --as "$ASTYPE"; rc=$?
else
  "$LARK" im +messages-send --profile "$PROFILE" --chat-id "$CHAT" --text "$TEXT" --as "$ASTYPE"; rc=$?
fi
if [ "$rc" -eq 0 ]; then echo "$NOW" > "$LASTF"; echo "[notify] 已发(bot=$BOT chat=$CHAT)" >&2
else echo "[notify] 发送失败 rc=$rc" >&2; fi
exit "$rc"
