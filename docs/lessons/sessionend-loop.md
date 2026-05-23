# Lesson: border-event hooks must not have external side effects

A `SessionEnd` hook that called `lark-cli ... messages-send` for a
"session ended" notification turned into a 286-message bombardment during
a single `/compact` cycle. Root cause analysis and the fix:

## What happened

1. The `PostCompact` hook returned a JSON payload trying to inject
   `additionalContext` for Claude:
   ```json
   {"hookSpecificOutput": {"hookEventName": "PostCompact",
                           "additionalContext": "..."}}
   ```
   The Claude Code hook schema only accepts `additionalContext` under
   `UserPromptSubmit`, `PostToolUse`, and `PostToolBatch`. `PostCompact`
   is not in that allow-list. The output failed validation.
2. The validation failure put Claude Code's hook handler into an error
   recovery path that mis-fired `SessionEnd` repeatedly.
3. Each `SessionEnd` fire called `lark-cli messages-send` with a fixed
   notification text. `>/dev/null 2>&1 || true` suppressed all signs of
   the duplication. Within minutes the Feishu chat had 286 identical
   messages.

## Why it slipped past review

The hook was written defensively ("if the bot is down, ignore"). That
defensiveness silenced the only signal that would have shown the loop.

There was also no inter-firing guard. The hook assumed CC would fire
`SessionEnd` at most once per session.

## Three fixes layered

1. **Remove the hook entirely.** No external-side-effect hook should
   run on border events (`SessionEnd`, `Stop`, `SubagentStop`,
   `PreCompact`). These events fire on more conditions than they look
   like they do. Notification belongs in the daemon (which knows whether
   the *user* is asking) or in the conversation flow, not in the hook
   system.
2. **Fix the `PostCompact` schema.** Either drop the JSON output or use
   the generic `{"continue": true, "suppressOutput": true}` shape.
   `additionalContext` is not legal here; trying to use it makes Claude
   Code's hook executor unhappy.
3. **Defense-in-depth wrapper.** All Feishu notification hooks now go
   through `notify-once.ps1`, which keys on `chat_id + tag` and skips
   silently if the same key was notified within the last N seconds
   (default 30). Even if a hook misfires in a tight loop, only one
   message goes out per window.

## Cleanup

Deleting 286 messages requires the `im messages delete` API. **Do not**
loop with a Bash subshell that pipes to a parser per call — 286 forks
exhausted Cygwin's process table and triggered "fork: retry: Resource
temporarily unavailable" cascades. Use a PowerShell loop that calls
`lark-cli api DELETE /open-apis/im/v1/messages/<mid>` once per ID with a
60 ms sleep between calls. Took ~3 minutes for 254 successful deletes
(32 timed out the bot's 24h recall window).

## Generalized rule

For any hook whose action is visible to a human or a third-party
service: **the hook is responsible for being idempotent**. CC fires
border events on more conditions than it looks like it does; if the
hook can't tolerate being called 100 times in 30 seconds, don't write
it. Either move the action into the daemon or wrap with a rate-limit.
