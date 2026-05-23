# Lesson: routing `PostCompact` notifications to the right bot

`~/.claude/settings.json` hooks are *global*. A hook that hardcodes a
`chat_id` sends every session's notifications to that one chat — so
finance-agent's `/compact` notice ends up in the primary bot's chat
along with the coding-assistant's notice and everyone else's. Confusing
in normal use, dangerous when notifications carry session-specific
context.

## Resolution algorithm

`notify-once.ps1 -AutoBot` resolves the destination at hook-fire time
through three layers, first hit wins:

1. **Per-session binding file.** Walk the parent process chain from the
   hook's PID until a process whose name starts with `claude` is found.
   If `~/.lark-cli/daemon/binding-<claude_pid>.json` exists, read its
   `chat_id` and `profile`. This is the most specific signal because
   each Claude session writes its own binding when it boots and binds a
   bot.
2. **Project-directory registry.** Read
   `~/.lark-cli/daemon/bot-registry.json`. Try each entry in
   `projects[]` and substring-match `$env:CLAUDE_PROJECT_DIR` (or
   `pwd` as fallback) against the entry's `match_dir_contains`. First
   hit wins. This catches sessions whose binding file didn't get
   written but whose cwd uniquely identifies the bot they should be
   using.
3. **`registry.default`** — used when nothing else matches. Should
   point at the operator's primary inbox.

A final hardcoded fallback exists in the script as a last-resort
safety net for when the registry file is missing or malformed.

## Binding file lifecycle

The binding file is keyed by the Claude PID, so it dies with the
session (next session boots with a new PID and writes a fresh file).
Old binding files for dead PIDs are harmless: `Find-ClaudePid` looks at
*this* hook's process tree, so a stale file for some other PID is
never consulted. A periodic prune is unnecessary but harmless.

## Where to add a new bot

When you register a new bot in `~/.lark-cli/config.json`, also update:

1. The `bot-registry.json`: add a `projects[]` entry if the bot is tied
   to a specific working directory (`match_dir_contains`).
2. The per-host secret-map (`~/.lark-cli/sync-secrets.local.json` in
   this layout): add entries to redact the new `cli_*`, `oc_*`, and
   `ou_*` strings before they end up in committed docs.
3. The session's binding file at startup, per the global preferences
   doc (`CLAUDE.md`). Without the binding file, `-AutoBot` falls
   through to the registry, which may or may not match.

## Why not just env vars?

Considered `$env:FEISHU_BOT_CHAT_ID` set by each session at startup.
Doesn't work: hooks run in fresh shell children spawned by Claude
Code, not in shells the user `export`-ed into. By the time the hook
runs the env var is gone. Files on disk survive.
