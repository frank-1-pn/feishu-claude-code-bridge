# Managed Codex transport repair

- Task: restore the existing Feishu-to-Codex delivery path without rebinding,
  adding subscribers, opening a network listener, or spawning another writer.
- Role: this session is the sole runtime integrator; the other existing session
  is read-only and will validate its own bot.
- Worktree: `C:/Users/ke/AppData/Local/Temp/feishu-managed-transport-20261007`.
- Branch: `fix/codex-managed-transport-20261007`.
- Verified remote maintenance baseline: `03f03726b4ddcb45575fed6d263b153fd4f9ed55`.
- Ownership: managed transport module/tests, writer resolver, narrow worker
  integration, inbox retry tests, and this plan/evidence. No veterinary code.
- Authority: diagnosis and repair requested; explicit commit/push and controlled
  reload with preserved stuck queues approved by the user's form reply on
  2026-10-07. Existing subscriber/bindings stay unchanged; no old writes replayed.

## Verified cause

Both subscribers have fresh real SDK pongs. The worker is alive, but the writer
lock belongs to the shared managed app-server, not an ancestor of a PTY. The
old resolver reports `writer_pty_not_found` and keeps messages queued.

The existing Codex 0.160.1 control socket accepts WebSocket, not JSONL. The
official `app-server proxy` forwards bytes to that socket; it does not start a
new server. A read-only HTTP Upgrade / initialize / loaded-list / thread-read /
turns-list probe verified both original bindings and working directories.

## Implementation

1. Resolve the exact lock owner against managed daemon PID, process start time,
   executable and command line, then verify the bound thread through that same
   daemon. Preserve legacy PTY and no-writer paths.
2. Reuse Orca's existing `ws` package over proxy stdio. Never open a TCP listener.
   Use `turn/steer` for an active turn and `turn/start` for an idle loaded thread;
   send no model, cwd, permissions, approval or sandbox overrides.
3. Persist submission before writes, retain rollout as delivery/final authority,
   and never retry an uncertain accepted write. Only explicit pre-write/rejected
   submissions may return to the durable queue.
4. Test target mismatch, timeout, refusal, busy/idle, Chinese and large prompts,
   interruption, same-message dedupe, restart, and existing bridge regression.
5. Before authorized loading: back up exact files/config/private state; reconcile
   each old pending job against user markers without replaying completed tasks.
   Retain subscribers, mappings, offsets and all messages. If an exceptional
   reload is not authorized, stop at tested candidate rather than fake idle.
6. After loading: real Feishu inbound -> original thread marker -> final outbox
   and message readback. Report unverified stages honestly.

Protocol reference: https://learn.chatgpt.com/docs/app-server

## Evidence

- The exact managed writer resolver and adapter preflight passed for both
  original bindings on 2026-10-07. No thread/permissions/model overrides were sent.
- `node --test daemon/*.test.mjs`: 307/307 passed, zero skips, exit 0 in the
  host test environment with process-only PowerShell execution policy. The first
  restricted-account run failed four existing PowerShell/GUI tests due to its
  execution policy; no code assertions were weakened to hide those failures.
- Actual WebSocket HTTP Upgrade tests use stream pairs, not a public listener;
  include large Chinese prompts, RPC refusal, internal/unknown error uncertainty,
  and restart without repeated writes. Independent review found and corrected
  the internal-RPC-error retry boundary. Documented ingress overload `-32001` is
  a safe pre-acceptance rejection per the official protocol reference above.
- Windows AF_UNIX sockets cannot be reliably tested with Node `existsSync`;
  the official proxy performs the endpoint validation and connection instead.
- Runtime installation and real Feishu ingress/final readback are pending.
