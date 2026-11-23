# Repository entry for Codex sessions

This `main` branch retains the original Claude integration. Current Windows
Codex/Orca bridge releases for the managed Windows transport are maintained on
[`stable/windows-codex`](https://github.com/frank-1-pn/feishu-claude-code-bridge/tree/stable/windows-codex).
Before an authorized configuration or recovery task, read that branch's
[AGENTS.md](https://github.com/frank-1-pn/feishu-claude-code-bridge/blob/stable/windows-codex/AGENTS.md),
[configuration and handoff guide](https://github.com/frank-1-pn/feishu-claude-code-bridge/blob/stable/windows-codex/codex-config/skills/feishu-bot-runtime/references/configuration-and-handoff.md)
and [Windows release guide](https://github.com/frank-1-pn/feishu-claude-code-bridge/blob/stable/windows-codex/docs/windows-codex-release.md).

- Opening this repository does not authorize connecting, rebinding or restarting
  a bot. Documentation work requires none of these operations.
- Preserve the existing subscribers and shared worker. Do not apply the legacy
  Claude Monitor/PID setup below to Codex; use current private thread bindings.
- Use an isolated worktree for changes; never overwrite another session's work.
  Commit, push and deploy only within the user's explicit scope.
- Keep keys, real configurations, message state and attachments outside Git.
  Documentation pointers on `main` do not mean the Codex runtime was merged here.
