# Architecture

How the pieces fit together. Read top-down; the lessons docs go deeper
on each rough edge.

## Layers, top to bottom

```
Feishu chat  ─┐                                         ┌── Feishu chat
              │                                         │
  user sends  │                                         │  bot replies
              ▼                                         ▲
        ┌─────────────────────────────┐    ┌────────────────────────┐
        │  Feishu WebSocket gateway   │    │  Feishu REST API       │
        └────────────┬────────────────┘    └────────────▲───────────┘
                     │ events                           │ messages-send
                     ▼                                  │
        ┌─────────────────────────────┐                 │
        │  lark-cli event +subscribe  │  (daemon)       │
        │  detached, --force,         │                 │
        │  --event-types ...receive   │                 │
        └────────────┬────────────────┘                 │
                     │ NDJSON, one event per line       │
                     ▼                                  │
        %TEMP%\lark-bot1-events.ndjson                  │
                     ▲                                  │
                     │ tail -c +OFFSET -F               │
                     │                                  │
        ┌────────────┴───────────────┐                  │
        │  monitor-bot.sh            │                  │
        │  per Claude Code session   │                  │
        │  awk: ^{"chat_id"          │                  │
        │       | /compact!/         │                  │
        │  + offset bookkeeping      │                  │
        └────────────┬───────────────┘                  │
                     │ stdout lines                     │
                     ▼                                  │
        ┌─────────────────────────────┐                 │
        │  Claude Code Monitor task   │                 │
        │  pushes events into chat    │                 │
        │  as task-notification       │                 │
        └────────────┬────────────────┘                 │
                     │                                  │
                     ▼                                  │
        ┌─────────────────────────────┐                 │
        │  Claude (this conversation) │─────────────────┘
        │  - reads task-notifications │  reply / notify
        │  - drives orchestration     │  via lark-cli  bot ID resolved
        │  - runs PostCompact hook    │  by notify-once.ps1 -AutoBot
        │    via notify-once.ps1      │
        └─────────────────────────────┘
```

## Trust and lifetime model

| Component                  | Lifetime           | Survives `/compact`? | Survives new Claude session? |
| -------------------------- | ------------------ | -------------------- | ---------------------------- |
| lark-cli daemon            | Until killed       | Yes                  | Yes                          |
| NDJSON event log           | Persistent file    | Yes                  | Yes                          |
| Monitor task               | This session       | **No** (always dies) | No                           |
| Offset file                | Persistent file    | Yes                  | Yes                          |
| Per-session binding file   | This session's PID | Yes (PID stable)     | No (new PID, new file)       |
| `bot-registry.json`        | Persistent         | Yes                  | Yes                          |
| `~/.claude/CLAUDE.md` rules| Persistent         | Yes                  | Yes                          |

The key insight: **the daemon and the NDJSON file are persistent; the
Monitor is ephemeral**. The offset file is the bridge — a new Monitor
resumes from exactly where the old one stopped, so the gap between
"Monitor died" and "new Monitor started" loses zero events as long as
the daemon stayed up.

## Why a daemon instead of running lark-cli under Monitor

Earlier versions (v2, v3) ran `lark-cli` as a child of the Monitor task.
That has two failure modes:

1. **The orphan problem.** When Monitor dies, the Node child process
   sometimes detaches (Windows process-group semantics differ from
   POSIX). Events keep flowing into a process that has nowhere to send
   them.
2. **The keepalive pollution problem.** Without a keepalive heartbeat,
   Monitor idles out after ~5 minutes (the same idle timeout that
   Anthropic's prompt cache uses, possibly the same code path). Adding a
   keepalive that emits `[keep HH:MM:SS]` every 4 minutes works, but
   each heartbeat is a real `task-notification` in Claude's
   conversation. Over an 8-hour session that's 120 fake messages
   competing for attention.

v4 splits them: the daemon owns the WebSocket and emits to disk; the
Monitor reads from disk and is allowed to idle out (with stream-ended
restart wired into the operator's reflexes). No keepalive needed.

## Why a binding file plus a registry

`~/.claude/settings.json` hooks are global. A `PostCompact` hook that
hardcodes a chat ID will fire for every session and send to the same
chat, no matter which bot that session is actually bound to. Three
resolution strategies were considered:

1. **Environment variables.** Hooks don't inherit `export`s from the
   session shell; CC spawns a fresh child for each hook fire. Rejected.
2. **Project-directory match only.** Fine when the bot ↔ project
   mapping is 1:1 (e.g., the finance-agent bot is always used in the
   finance-agent-spec project). Fails when the operator runs two
   different bots from the same cwd.
3. **Per-session binding file keyed by Claude PID.** Walk the hook's
   parent chain, find `claude.exe`, look up
   `~/.lark-cli/daemon/binding-<pid>.json`. Most specific signal
   possible. The file dies with the PID, so cleanup is free.

The current `notify-once.ps1` uses strategy 3 first and falls through
to strategy 2 (registry by `match_dir_contains`), then to a static
`registry.default`, then to a hardcoded chat ID. Each layer is a
fallback for the prior layer; in practice strategy 3 succeeds for
sessions that follow the CLAUDE.md self-check protocol.

## Why `/compact` over Feishu has to be a keyboard macro

`/compact` is a CLI-only command. It triggers context compaction at the
harness level. Plugin systems (Channels, OpenClaw, Telegram bridges)
expose conversational surfaces but do not give plugins a hook into
context compaction — this is by design from Anthropic. We
double-checked the Channels protocol source: there is no compaction
endpoint.

The remaining option is to drive the desktop CLI from outside. The
keyboard macro path:

1. Find the foreground window. If it isn't a Claude Code window
   (i.e. its process tree doesn't contain `claude.exe`), refuse.
2. Confirm with the operator (screenshot of the window goes to Feishu).
3. Type `/compact` (no Enter).
4. Screenshot again. Confirm with the operator.
5. Press Enter, or clear if the operator says no or doesn't reply in
   30s.

Both checkpoints exist because the cost of firing `/compact` in the
wrong window is high (losing in-progress conversation) and the cost of
firing it where the operator didn't expect it (typing into a code
editor that happens to be focused) is higher.

## Failure mode reference

| Symptom                                       | Likely cause                                | Lesson                          |
| --------------------------------------------- | ------------------------------------------- | ------------------------------- |
| Bot online, `messages-send ok=true`, but no messages reach Claude | Orphan subscribe (Monitor died, lark-cli still running) | `monitor-pipe.md` |
| `[SDK Error] handle message failed ... not found handler` flood in Monitor | awk filter was widened past `^{"chat_id"` | `monitor-pipe.md` |
| New Monitor stream-ends within 1s of start    | Server hasn't released previous connection  | Use `--force` + 3 s sleep       |
| Hundreds of identical Feishu notifications    | Border-event hook with no rate limit        | `sessionend-loop.md`            |
| `/compact` notice goes to the wrong bot       | Global hook hardcoded a chat ID             | `notify-routing.md`             |
| Hook output rejected: "Hook JSON output validation failed" | `additionalContext` used on a non-allow-listed event | Drop the JSON output or use generic shape |
