#!/bin/bash
# feishu-tail.sh <bot> — Claude session 事件桥接 Monitor 入口:tail 持久日志 → 当前对话。
# 比裸 `tail -n 0 -F` 多两层防护(仍只是只读 tail,绝不碰订阅连接 / 不 +subscribe / 不 --force):
#   ① message_id 去重:BEGIN 先把现有 log 里的 id 全 seed 进表,之后只放行【从未见过】的 id
#      → 免疫"日志被重写/截断后 tail -F 从头重放历史"造成的【重复消息刷屏】。
#      (根因:launchd 长连接定期重连会重写/截断日志;tail -F 检测到文件变小/换 inode 从头重读,
#       把已处理过的近期消息当新事件再喷一遍 → 用户看到一直说"duplicate"。)
#   ② 卡键乱码过滤:丢掉手机长按重复发的 "A#" / "A #" / "A\" 等 ≤5 字符短垃圾。
#      (刷屏量大能把 Monitor 冲到 auto-stop → 重 arm 用 -n 0 又跳过积压 → 真漏消息。)
# Session arm:
#   Monitor({ command: "~/.claude/bin/feishu/feishu-tail.sh <bot>",
#             description: "飞书事件桥接 <bot>", persistent: true, timeout_ms: 3600000 })
set -u
BOT="${1:?usage: feishu-tail.sh <bot>}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/feishu-lib.sh"
LOG="$(feishu_log_path "$BOT")"   # 持久日志 ~/Library/Logs/feishu/<bot>.log

# 订阅桥可能还没写出日志文件 → 等它出现(最多 60s)
for _ in $(seq 1 60); do [ -f "$LOG" ] && break; sleep 1; done

# -n 0:arm 时不回放历史;-F:跟随 rotate/truncate。
# grep:丢卡键乱码短串。awk:seed 现有 message_id,只放行从未见过的 id(重写重读也不会重复)。
exec /usr/bin/tail -n 0 -F "$LOG" \
  | grep --line-buffered -Ev '"content":"[A #\\]{1,5}"' \
  | awk -v seed="$LOG" '
      BEGIN {
        while ((getline line < seed) > 0)
          if (match(line, /"message_id":"[^"]+"/)) s[substr(line, RSTART, RLENGTH)] = 1
        close(seed)
      }
      {
        if (match($0, /"message_id":"[^"]+"/)) {
          id = substr($0, RSTART, RLENGTH)
          if (s[id]++) next
        }
        print; fflush()
      }'
