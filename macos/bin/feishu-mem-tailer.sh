#!/bin/bash
# feishu-mem-tailer.sh <bot> — launchd 入口:tail -F ~/Library/Logs/feishu/<bot>.log → claude-mem
# 只读日志,绝不碰 com.frank.feishu.<bot> 订阅连接。pipeline 退出由 launchd KeepAlive 拉起。
set -u
BOT="${1:?usage: feishu-mem-tailer.sh <bot>}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/feishu-lib.sh"
LOG="$(feishu_log_path "$BOT")"   # 持久日志 ~/Library/Logs/feishu/<bot>.log(不再读 /tmp,见 feishu-lib.sh)

# 订阅桥可能还没写出日志文件 → 等它出现(最多 60s)
for _ in $(seq 1 60); do [ -f "$LOG" ] && break; sleep 1; done

# -n 0:只读新消息(重启不回放旧日志);-F:跟随 rotate/truncate
exec /usr/bin/tail -n 0 -F "$LOG" | /usr/bin/python3 "$DIR/feishu-mem-poster.py" "$BOT"
