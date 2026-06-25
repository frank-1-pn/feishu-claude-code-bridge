#!/bin/bash
# feishu-add-bot.sh <name> <app_id> <chat_id> [alias] — 注册一个新 bot + 装 launchd 看门狗。
# 前提: 该 app 的 lark-cli profile 已存在且登录(profile 名默认 = app_id)。
#       没有的话脚本只写注册表、提示先登录,不装 agent。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/feishu-lib.sh"

NAME="${1:?usage: feishu-add-bot.sh <name> <app_id> <chat_id> [alias]}"
APPID="${2:?需要 app_id (cli_...)}"
CHAT="${3:?需要 chat_id (oc_...)}"
ALIAS="${4:-$NAME}"
LARK="$(feishu_larkcli)"

# 注册表/目录不存在时先种子化(否则首个 bot 无法登记 —— jq 读不到输入文件会失败)
mkdir -p "$FEISHU_DAEMON_DIR"
[ -f "$FEISHU_REGISTRY" ] || printf '{"bots":{},"projects":[],"default":null}\n' > "$FEISHU_REGISTRY"

feishu_bot_exists "$NAME" && { echo "✗ bot 名 '$NAME' 已在注册表里" >&2; exit 1; }
case "$APPID" in cli_*) :;; *) echo "✗ app_id 应以 cli_ 开头: $APPID" >&2; exit 1;; esac
# app_id 不能与已有 bot 重复(防 profile 撞车)
"$JQ" -e --arg a "$APPID" '.bots|to_entries[]|select(.value.app_id==$a)' "$FEISHU_REGISTRY" >/dev/null 2>&1 \
  && { echo "✗ app_id $APPID 已被其它 bot 占用" >&2; exit 1; }

# 原子写注册表
TMP="$(mktemp)"
"$JQ" --arg n "$NAME" --arg a "$APPID" --arg c "$CHAT" --arg al "$ALIAS" \
  '.bots[$n] = {app_id:$a, profile:$a, chat_id:$c, alias:$al, as:"bot", event_types:"im.message.receive_v1", enabled:true, notify_on_restart:true}' \
  "$FEISHU_REGISTRY" > "$TMP" && mv "$TMP" "$FEISHU_REGISTRY" || { echo "✗ 写注册表失败" >&2; rm -f "$TMP"; exit 1; }
echo "✓ 已注册 bot '$NAME' (app_id=$APPID chat=$CHAT alias=$ALIAS)"

# profile 是否已登录?
if ! "$LARK" profile list 2>/dev/null | "$JQ" -e --arg a "$APPID" '.[]|select(.appId==$a)' >/dev/null 2>&1; then
  cat >&2 <<EOF
⚠️ 还没有 app $APPID 的 lark-cli profile。先登录(Claude 会带你做):
   printf '%s' '<APP_SECRET>' | lark-cli profile add --app-id $APPID --name $APPID --app-secret-stdin --brand feishu
   # (可选,仅需 user 身份时)lark-cli auth login --profile $APPID --domain im   # 把授权链接转给用户
登录完成后再跑:  $DIR/feishu-install-agent.sh $NAME
EOF
  exit 2
fi

# 已登录 → 装看门狗
"$DIR/feishu-install-agent.sh" "$NAME"
echo "✓ bot '$NAME' 已上线。Claude 记得在本 session arm 事件桥接:"
echo "    tail -n 0 -F $(feishu_log_path "$NAME")"
