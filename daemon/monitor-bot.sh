#!/bin/bash
# v4 Monitor wrapper for Bot1
# - Reads <USER_HOME_MSYS>/AppData/Local/Temp/lark-bot1-events.ndjson via tail -c +OFFSET -F
# - Updates lark-bot1-monitor.offset after each line consumed
# - Survives stream-ended restart without losing events
# - Detects /compact! trigger from authorized user → emits [COMPACT_TRIGGER] marker

# Use POSIX-style paths to avoid backslash escape issues when passed to awk
LOG="<USER_HOME_MSYS>/AppData/Local/Temp/lark-bot1-events.ndjson"
OFFSET_FILE="<USER_HOME_MSYS>/AppData/Local/Temp/lark-bot1-monitor.offset"
# Authorized sender for /compact! trigger
MY_OPEN_ID="<USER_OPEN_ID>"

# Determine start offset
if [ ! -f "$LOG" ]; then
    touch "$LOG"
fi
FILE_SIZE=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
if [ -f "$OFFSET_FILE" ]; then
    START_OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)
    if [ "$START_OFFSET" -gt "$FILE_SIZE" ]; then
        START_OFFSET=0
    fi
else
    START_OFFSET=$FILE_SIZE
    echo "$START_OFFSET" > "$OFFSET_FILE"
fi

TAIL_START=$((START_OFFSET + 1))

tail -c "+$TAIL_START" -F "$LOG" 2>/dev/null | awk -v OFFSET_FILE="$OFFSET_FILE" -v OFFSET="$START_OFFSET" -v MY_OPEN_ID="$MY_OPEN_ID" '
{
    OFFSET += length($0) + 1
    print OFFSET > OFFSET_FILE
    close(OFFSET_FILE)

    if (index($0, "{\"chat_id\"") == 1) {
        print
        # /compact! trigger detection (authorized sender only)
        if (index($0, "\"content\":\"/compact!\"") > 0 && index($0, "\"sender_id\":\"" MY_OPEN_ID "\"") > 0) {
            print "[COMPACT_TRIGGER] " $0
        }
        fflush()
    }
}
'
