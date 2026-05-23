# Lesson: triggering `/compact` from Feishu (keyboard macro)

We wanted: send `/compact!` from Feishu, have the right Claude Code
session in the foreground actually run `/compact`. Considered three
paths; only one is reachable.

## What doesn't work

1. **Channels plugin** (Anthropic's official multi-channel surface for
   Claude Code). Channels gives you bidirectional message routing, but
   it does not expose `/compact` to remote callers. The CLI harness
   never wires that command into a channel API. We checked the Channels
   plugin source — there is no `/compact` route.
2. **Telegram-style plugins** (OpenClaw, opencode). Same problem at a
   different layer: the harness owns context compaction and does not
   give plugins a handle to invoke it. There is no smuggling path.

`/compact` is a CLI-only command. Any remote-trigger path has to drive
the CLI input externally.

## What works: keyboard macro into the foreground terminal

A `awk` rule in `monitor-bot.sh` watches for messages whose `content`
is exactly `/compact!` (with the exclamation mark, to keep accidental
casual mentions from firing) and whose `sender_id` is the operator's
`open_id` (whitelist). When matched, it emits a marker line:
`[COMPACT_TRIGGER] <original JSON>`. The Monitor pushes that marker to
Claude as an event. Claude then runs a three-phase orchestration that
puts a human checkpoint at every dangerous step.

### Phase 1 — propose (which session?)

1. Run `find-claude.ps1`, which gets the foreground window via
   `GetForegroundWindow`, walks its process tree, and confirms a
   `claude.exe` descendant exists.
2. Failure modes are returned as `{error: "no_foreground"}` or
   `{error: "no_claude_in_tree"}`. Each gets a clear Feishu reply asking
   the user to focus the right window.
3. On success, screenshot the window with `screenshot-window.ps1`,
   upload to Feishu, and post:
   ```
   📋 准备 compact:
   PID 终端=...  PID claude=...
   窗口标题: ...
   [screenshot]
   ✅ 回 yes 进入 Phase 2
   ❌ 回 no 或 30 秒不回 = 取消
   ```
4. Wait for yes/no/timeout.

### Phase 2 — input preview (did I type the right thing?)

On `yes`, re-run `find-claude.ps1` and verify the foreground window's
hwnd matches Phase 1's. If the user switched windows in the meantime,
abort with a clear message.

If hwnd matches, send the literal string `/compact` (no Enter yet) via
`send-keys.ps1 -Action text`. The script's foreground check refuses to
fire if the target window is no longer in front. Screenshot the
post-input state, post to Feishu:
```
⌨️ 已输入 /compact 到目标窗口
[screenshot]
✅ 回 yes 按 Enter 执行
❌ 回 no 撤销（清空输入）
```

### Phase 3 — execute or abort

- `yes` → `send-keys.ps1 -Action enter`.
- `no` → `send-keys.ps1 -Action clear` (Ctrl+A then Delete).
- 30 s timeout → also clear, never leave half-typed input behind.

## Why two checkpoints

The cost of running `/compact` on the wrong session is large (lose
in-progress conversation). The cost of mis-typing the command (it lands
in a code file or a Bash terminal) is larger. Both are quick to recover
from with the screenshot + yes/no gates; both are unrecoverable without
them.

## Hard rule

`send-keys.ps1` refuses to fire if `GetForegroundWindow` returns
something other than the hwnd the caller passes. Pass `Hwnd=0` and it
rejects explicitly. This is the load-bearing safety check.
