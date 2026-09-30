# feishu-claude-code-bridge

## Windows Codex / Orca 接手入口

当前 Codex bridge 代码与配置文档维护在
[`feat/feishu-ux-20260927`](https://github.com/frank-1-pn/feishu-claude-code-bridge/tree/feat/feishu-ux-20260927)。
新 Codex session 请先读[配置与接手指南](https://github.com/frank-1-pn/feishu-claude-code-bridge/blob/feat/feishu-ux-20260927/codex-config/skills/feishu-bot-runtime/references/configuration-and-handoff.md)
和[运行版本核对记录](https://github.com/frank-1-pn/feishu-claude-code-bridge/blob/feat/feishu-ux-20260927/docs/feishu-runtime-sync-20260930.md)。

本 `main` 分支保留原 Claude 实现；下面的 Monitor / Claude PID 绑定步骤不适用于当前 Codex bridge。
本机现有连接应复用，不因新 session 自动改绑或重启。新机器还有本机依赖需要配置，不能只克隆仓库就启动；密钥、真实绑定与消息状态不上传 Git。

## Original Claude Code integration

Personal-use bridge between Feishu (Lark) chats and a long-running
Claude Code session on Windows. Lets the operator drive a desktop
Claude Code instance from their phone — receive messages, run quick
commands, trigger `/compact` remotely — without polluting Claude's
context with heartbeats.

This repo captures the **mechanism**: scripts, hooks, configuration
templates, and the architecture/lessons docs. Real secrets
(`cli_*` app IDs, `oc_*` chat IDs, `ou_*` open IDs) are never
committed; the sync script reads them from a host-local map outside
the repo.

> **Caveat.** This is a single-operator setup tuned to one machine.
> The mechanisms generalize, but the specific paths, hook layout,
> and registry shape assume Windows + Claude Code + lark-cli +
> Git Bash / PowerShell.
>
> **macOS port:** a `launchd`-based re-implementation lives in
> [`macos/`](macos/) — same multi-bot / per-session-routing model,
> native to macOS (`launchd` + `bash` + `lark-cli` keychain).
> Start at [`macos/README.md`](macos/README.md).

## What it does

- **Inbound messages** from any of N registered Feishu bots arrive
  in the corresponding Claude Code session within seconds. Survives
  `/compact`, Monitor restarts, and brief network blips without
  losing events.
- **Outbound replies and notifications** route to the bot
  belonging to the session that sent them — no cross-talk.
- **`/compact` over Feishu** (`/compact!` triggers it): a two-stage
  human-checkpointed keyboard macro that screenshots the target
  window, types `/compact`, screenshots again, and waits for `yes`
  before pressing Enter.
- **No notification spam.** Border-event hooks (`SessionEnd`,
  `PostCompact`) route through `notify-once.ps1`, which dedupes by
  `chat_id + tag` over a sliding window.

## Repo layout

```
daemon/                  scripts that run on the user's machine
  start-bot.ps1          first-time daemon launcher (idempotent)
  ensure-bot.ps1         health-check + auto-heal + logrotate
  monitor-bot.sh         per-session Monitor wrapper (offset-tracked tail)
  find-claude.ps1        foreground-window → claude.exe locator
  screenshot-window.ps1  Win32 GDI window screenshot
  send-keys.ps1          SendKeys with foreground-guard
  notify-once.ps1        rate-limited, bot-aware Feishu notifier
  bot-registry.example.json   project_dir → bot routing template

claude-config/
  CLAUDE.md              global Claude Code preferences (startup
                         self-check, liveness rules, §6 binding step)
  settings.hooks.example.json   the hooks fragment for ~/.claude/settings.json
  scripts/
    pre-compact-model-switch.py    PreCompact: swap model to sonnet
    post-compact-model-restore.py  PostCompact: restore prior model

docs/
  integration-guide.md   long-form architecture write-up (v4.2)
  lessons/
    monitor-pipe.md      why the subscribe pipeline is fragile and how
                         to keep it honest
    sessionend-loop.md   the 286-message bombardment; why border-event
                         hooks must not have external side effects
    compact-trigger.md   why remote /compact has to be a keyboard
                         macro, and how to make it safe
    notify-routing.md    per-session bot resolution for global hooks

scripts/
  sync-from-local.ps1    pulls from the live install + auto-sanitizes
                         using ~/.lark-cli/sync-secrets.local.json,
                         then runs a leak-guard scan

macos/                   macOS port (launchd-based; self-contained)
  install.sh             one-shot framework installer for a new Mac
  bin/                   the bridge scripts (→ ~/.claude/bin/feishu/)
  examples/              bot-registry.example.json
  docs/                  SETUP.md · MULTI-BOT.md · ARCHITECTURE.md
  README.md              start here for macOS

.gitignore               excludes per-session and runtime files
```

## Quick start (re-creating this on a fresh machine)

1. Install [@larksuite/cli](https://www.npmjs.com/package/@larksuite/cli)
   and log in your first bot:
   ```bash
   npm install -g @larksuite/cli
   lark-cli config init
   lark-cli auth login --as bot
   ```
2. Drop the `daemon/` scripts under `~/.lark-cli/daemon/`. Rename
   `bot-registry.example.json` to `bot-registry.json` and fill in
   the chat IDs / profiles you actually have.
3. Copy `claude-config/CLAUDE.md` to `~/.claude/CLAUDE.md` (or merge
   into your existing one — read `§ 启动自检` carefully, especially
   `§6` which writes the per-session binding file).
4. Merge `claude-config/settings.hooks.example.json` into your
   `~/.claude/settings.json` (keep your other settings; just bring
   in the `hooks.PostCompact` entry). Copy `claude-config/scripts/*.py`
   to `~/.claude/scripts/` — the `Pre/PostCompact` model-switch hooks
   reference them.

   > **Heads-up:** the example fragment also references three scripts
   > that live in *other* stacks and are **not** in this repo:
   > `claude-mem-autopatch.ps1` + `claude-agent-sdk-autopatch.ps1`
   > (claude-mem stack) and `finance-agent-spec/.../postcompact_handler.py`
   > (a separate project). Drop those hook entries unless you also run
   > those stacks — only `SessionStart` (skill loader), the
   > `PostCompact notify-once.ps1 -AutoBot` entry, and the two bundled
   > model-switch hooks are part of *this* Feishu bridge.
5. Write `~/.lark-cli/sync-secrets.local.json` (see "Per-host secrets
   mapping" below). This is the **only** file in this whole setup
   that contains live secrets and it is the **only** file that must
   not be committed anywhere.
6. Bring up the daemon for your primary bot:
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Users\you\.lark-cli\daemon\ensure-bot.ps1
   ```
7. Start a Claude Code session, walk through the self-check in
   `CLAUDE.md`, start a Monitor, write your binding file, send a
   heartbeat. You should see the heartbeat in Feishu.

## Per-host secrets mapping

`~/.lark-cli/sync-secrets.local.json` shape:

```json
{
  "replacements": [
    {"from": "cli_<your-app-id>",     "to": "<APP_ID_BOT_PRIMARY>"},
    {"from": "oc_<your-chat-id>",     "to": "<CHAT_ID_BOT_PRIMARY>"},
    {"from": "ou_<your-open-id>",     "to": "<USER_OPEN_ID>"},
    {"from": "C:\\Users\\<you>\\",    "to": "<USER_HOME>\\"},
    {"from": "/c/Users/<you>/",       "to": "<USER_HOME_MSYS>/"}
  ]
}
```

`sync-from-local.ps1` reads this file at run time, applies every
replacement as a literal string substitution against every synced
file, then scans the output for any leftover `cli_*` / `oc_*` /
`ou_*` tokens and aborts loudly if it finds one. The replacement
table lives here and not in the script so the script itself can be
checked in safely.

## Ongoing sync workflow

When you change a daemon script or the CLAUDE.md preferences:

```powershell
# from anywhere — script resolves its own repo root
powershell -ExecutionPolicy Bypass -File scripts/sync-from-local.ps1
cd C:\path\to\feishu-claude-code-bridge
git diff                            # eyeball the change
git commit -am "ensure-bot: handle <thing>"
git push
```

The sync script is intentionally one-way (local → repo). If you want
to apply a change *from* the repo back to the live install, copy the
file manually — there is no `apply-to-local.ps1` to avoid accidental
overwrites of in-flight local edits.

## Lessons (most useful files)

- `docs/lessons/monitor-pipe.md` — the orphan-subscribe trap, what
  is and isn't a liveness signal, the `--force` + 3 s sleep
  re-takeover dance.
- `docs/lessons/sessionend-loop.md` — why `SessionEnd` hooks must
  never call out to anything (286-message incident).
- `docs/lessons/notify-routing.md` — three-tier bot resolution for
  global hooks (binding file → registry → default).
- `docs/lessons/compact-trigger.md` — Channels can't do `/compact`;
  keyboard macros can, with two human checkpoints.
- `docs/integration-guide.md` — long-form v4.2 write-up of the whole
  daemon architecture including the v3 → v4 migration.

## License

Private; no license granted. Don't redistribute without asking.
