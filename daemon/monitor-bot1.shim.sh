#!/bin/bash
# Backward-compat shim. Use monitor-bot.sh bot1 directly.
exec bash "$(dirname "$0")/monitor-bot.sh" bot1
