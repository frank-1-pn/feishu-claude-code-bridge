#!/bin/bash
# Parametrized Monitor wrapper.
# Usage:
#   bash monitor-bot.sh bot1
#   bash monitor-bot.sh coding
#   bash monitor-bot.sh finance
#
# Reads <USER_HOME_MSYS>/AppData/Local/Temp/lark-<bot>-events.ndjson via tail -c +OFFSET -F
# and updates lark-<bot>-monitor.offset after each consumed line so a restart
# resumes exactly where we left off.
#
# Also routes the operator's `/compact!` to a `[COMPACT_TRIGGER]` marker line.

BOT="${1:-bot1}"

case "$BOT" in
    [a-zA-Z0-9_-]*) ;;
    *) echo "ERROR: bad bot name '$BOT'"; exit 2 ;;
esac

LOG="<USER_HOME_MSYS>/AppData/Local/Temp/lark-${BOT}-events.ndjson"
OFFSET_FILE="<USER_HOME_MSYS>/AppData/Local/Temp/lark-${BOT}-monitor.offset"

# Authorized sender for /compact! trigger
MY_OPEN_ID="<USER_OPEN_ID>"

if [ ! -f "$LOG" ]; then
    touch "$LOG"
fi
FILE_SIZE=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
if [ -f "$OFFSET_FILE" ]; then
    START_OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)
    if [ "$START_OFFSET" -gt "$FILE_SIZE" ]; then
        # File was rotated under us → start from 0
        START_OFFSET=0
    fi
else
    # First run for this bot → skip history (don't replay old events)
    START_OFFSET=$FILE_SIZE
    echo "$START_OFFSET" > "$OFFSET_FILE"
fi

TAIL_START=$((START_OFFSET + 1))

tail -c "+$TAIL_START" -F "$LOG" 2>/dev/null | awk \
    -v OFFSET_FILE="$OFFSET_FILE" \
    -v OFFSET="$START_OFFSET" \
    -v MY_OPEN_ID="$MY_OPEN_ID" '
{
    OFFSET += length($0) + 1
    print OFFSET > OFFSET_FILE
    close(OFFSET_FILE)

    if (index($0, "{\"chat_id\"") == 1) {
        print
        if (index($0, "\"content\":\"/compact!\"") > 0 && index($0, "\"sender_id\":\"" MY_OPEN_ID "\"") > 0) {
            print "[COMPACT_TRIGGER] " $0
        }
        fflush()
    }
}
'
