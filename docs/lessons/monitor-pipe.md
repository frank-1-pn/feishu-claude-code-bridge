# Lesson: keeping the Monitor pipeline honest

Hard-won rules for `lark-cli event +subscribe` ⇒ Claude Code `Monitor` plumbing.

## The orphan-subscribe trap

`lark-cli` subscribe is a Node child process. When the Claude Code `Monitor`
task that wraps it dies (because `/compact`, session restart, idle-timeout,
or a broken pipe), the underlying `lark-cli` process **does not die with
it** — it detaches and keeps consuming events from Feishu while nothing in
Claude listens. Result: Feishu shows the bot online, `messages-send`
returns `ok: true`, and user messages vanish silently.

What to do:
- After **every** `/compact` and at **every** new session start, assume the
  Monitor is orphaned. Don't trust hooks. Run the daemon-ensure script,
  then start a fresh Monitor.
- To detect orphans: `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`
  filtered to `*event*subscribe*`. Any subscribe whose `--profile` matches
  the bot you care about, but whose Monitor task ID is no longer known in
  the current conversation, is an orphan. Kill with `Stop-Process -Id <pid>
  -Force`.

## What is *not* a liveness signal

- **`messages-send ok=true`** proves outbound works. It says nothing about
  inbound events reaching Claude.
- **`TaskList` / `TaskGet`** do not list `Monitor` watches; only
  `TaskCreate`-style tasks show up. `TaskGet <monitor-task-id>` returns
  `Task not found` even for healthy monitors. Don't use these to decide
  whether the link is alive.
- **`Get-CimInstance` finding the subscribe process** is necessary but not
  sufficient. The orphan scenario above is exactly the case where the
  process is alive but the events go nowhere.

## What *is* a liveness signal (strongest first)

1. **An inbound `task-notification` just landed** whose `task-id` matches
   the Monitor task the current session started. That message came over
   the live pipe — by construction the link is up.
2. **`Monitor "..." stream ended`** notification = the Monitor task is
   dead. Restart immediately, no questions asked.

## Pipeline filter must not buffer

Stdio between `lark-cli`, the filter, and Monitor is line-oriented in
spirit but block-buffered by default. Without explicit flushes events
queue up for tens of minutes and look like a dead stream:

- `stdbuf -oL lark-cli ...` — forces `lark-cli`'s stdout to line-buffered.
- The filter must flush per line. Use `awk '/^{"chat_id"/ { print; fflush() }'`,
  not bare `grep` (which is mostly fine but had a 50-minute stall in one
  measured case).
- Do **not** widen the awk pattern to include `ERROR|disconnect|reconnect`
  to "see more". `lark-cli` 1.0.x writes `[SDK Error] handle message
  failed ... not found handler` for read-receipt and bot-entry events the
  SDK doesn't have handlers for. These are SDK noise. If Monitor sees them
  as real events it counts them, and after a few of them it auto-stops
  with a "too many events" cutoff.

To keep raw output for forensics, `tee` *before* awk: 
```bash
… lark-cli … | tee /tmp/lark-bot-monitor.log | awk '...'
```

## "another event +subscribe instance is already running"

The Feishu service tracks one connection per app. After you kill an
orphan, restarting a new subscribe **immediately** races the server's
disconnect-detection window (30s–2m). Two protections:

1. Always pass `--force` to `lark-cli event +subscribe`. This tells the
   server you intend to take over.
2. After `Stop-Process`, sleep ~3 seconds before launching the new
   Monitor. Without the gap, even `--force` can lose the race in the
   first few seconds.

The local lockfile under `~/.lark-cli/locks/subscribe_<app_id>.lock` is
just a marker — deleting it does not help. Treat the server's
connection-tracking as the source of truth.

## v4 daemon mode (current architecture)

The v3 design ran `lark-cli` as a child of Monitor with a keepalive
sub-shell. It worked but was fragile: every keepalive heartbeat showed up
as a "[keep HH:MM:SS]" task-notification in the conversation, polluting
Claude's context with ~15 messages per hour of nothing.

v4 splits the two cleanly:

- The **daemon** (`start-bot.ps1` / `ensure-bot.ps1`) runs `lark-cli` via
  `Start-Process -WindowStyle Hidden`, detached. Stdout goes to an
  NDJSON file under `%TEMP%`. The daemon survives `/compact`, Claude
  restarts, and session exit.
- The **per-session Monitor** runs `monitor-bot.sh`, which uses
  `tail -c +OFFSET -F` on the NDJSON file. Offset is tracked in a
  sibling `.offset` file so that, after `Monitor` dies and restarts, the
  new Monitor resumes exactly where the previous one stopped — **no
  events lost** during the gap.

Hard rule: **stream-ended → restart Monitor immediately**, do not finish
the current thought first. The offset file means you don't lose history,
but you do lose any "happening now" notification until the new Monitor is
up.
