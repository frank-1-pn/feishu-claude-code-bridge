# Feishu bridge repository

## Start here

This repository contains both the original Claude integration and the Windows
Codex bridge. The Codex publication entry is `stable/codex`; `main` retains the
legacy Claude setup. Select an exact tested, published commit and its external
release manifest; feature branches and a moving branch tip are not deployment
authority. Read [runtime releases](docs/runtime-release.md), then [the runtime skill](codex-config/skills/feishu-bot-runtime/SKILL.md)
and its [configuration and handoff guide](codex-config/skills/feishu-bot-runtime/references/configuration-and-handoff.md)
before an authorized connection, configuration or recovery task.

The installed runtime and private bindings on the host are authoritative for
current bots and sessions. A repository checkout is not proof of deployment.
Do not connect, rebind, start a subscription or restart a worker just because a
new Codex session opened this repository. Documentation-only work needs none
of those operations.

## Changes and deployment

- Use an isolated worktree/branch; inspect status and declare owned paths.
  Do not include another session's changes in a commit.
- Keep one subscriber per bot/profile and preserve the existing shared bridge.
  Do not use old Claude Monitor or PID bindings for Codex routing.
- Credentials, real `codex-thread-bindings.json`, registries, message state,
  logs, downloads and deployment backups stay outside Git. Publish placeholders
  only; scan exact staged paths against local private values before pushing.
- Commit/push/deploy only within the user's authorized scope. Deploy only a
  fixed, tested and pushed revision. Wait for active Codex work and every
  delivery queue to finish; process presence or `bridge.state=idle` alone is
  insufficient. Never interrupt coding to reload documentation.
- Keep publication, source tests, installed hash checks and real human acceptance
  as separate evidence. `scripts/bridge-release.mjs` only reads source/declared
  installation files; it cannot install, start services or validate a live bot.
  Keep generated manifests outside the checkout; the tracked release profile
  contains paths/dependency constraints, never its own commit/tree hashes.
- Validate according to the change. For runtime changes, run the relevant
  `node --test` suites and prove real ingress into the intended thread plus
  final delivery. For documentation, check examples, links and private-data
  exclusion; do not claim a new runtime acceptance test.
- Keep setup procedures in the handoff guide and task-specific references.
  Record dated deployment evidence separately from ongoing configuration rules.

The [global instruction bundle](codex-config/AGENTS.md) is an installation source;
merge needed rules into the active Codex home without replacing unrelated rules.
