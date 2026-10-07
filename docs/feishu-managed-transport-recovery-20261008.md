# Managed daemon delivery recovery — 2026-10-08

Runtime source: `e521f1c884f404f66a363ff105dbae22e12f7115`, pushed to
`fix/codex-managed-transport-20261007`. This is a task branch, not a claim that
the maintenance branch has been integrated.

## Fault and repair

Real subscriber SDK pongs remained healthy. The old bridge identified a writer
but could not locate a PTY because newer Orca uses a shared managed app-server.
It repeatedly queued messages with `writer_pty_not_found`.

The resolver now verifies the managed writer PID, exact start time, executable
root and command line. The bridge connects to that **existing** daemon using
the official proxy and WebSocket HTTP Upgrade over pipes. It verifies the exact
loaded thread and bound cwd, steers active turns, and starts a turn on an idle
loaded thread. It sends no model/approval/sandbox/cwd overrides. Legacy PTY and
no-writer paths remain available. There is no second subscriber, daemon, writer,
or network listener.

## Validation and installation

- 307/307 host regression tests passed, zero skipped. Real stream-pair WebSocket
  tests cover Chinese large messages, busy/idle routing, refusal, ambiguous
  response and restart without repeated execution.
- Both exact original bindings passed read-only live resolver and adapter
  preflight. Independent review corrected the internal/unknown RPC error retry
  boundary before deployment.
- User explicitly approved commit, push and exceptional controlled recovery
  while stuck queues were nonempty. The sole integrator backed up runtime files,
  configuration, durable state and offsets outside Git, then restarted only the
  exactly identified bridge worker. Original subscribers were not restarted.
- Installed files match the pushed runtime revision; binding bytes stayed
  unchanged. No queue was deleted, no offset rewound, and no completed operation
  was injected again. A legacy-header submitted record was reconciled using its
  exact user event and completed turn; only its original reply was recovered.

## Observed live result

- `healthy`, `transport_healthy`, `delivery_healthy` were all true; both real
  subscriber pongs were fresh and the worker identity was exact.
- Coding's formerly queued actual request reached the original model turn via
  native steering. Its progress card was fetched with `messages-mget`: exact
  expected message, original chat, not deleted, matching public progress text.
- Bot1's three queued messages reached the original thread and finished. Its
  combined final and recovered legacy final were independently fetched with
  `messages-mget`, matching original chat and final text. No manual resend.
- At this evidence point coding was correctly waiting for this still-active
  turn's final answer. That final has not yet been externally read back; do not
  describe this as a completed coding final receipt or long-term soak test.

The installed runtime skill still describes the legacy two-route topology.
Its no-second-writer/whitelist/outbox/approval rules remain binding, but future
diagnosis must account for this managed-daemon route and installed fixed ref.
General skill refresh and maintenance-branch integration are not claimed here.

Protocol: https://learn.chatgpt.com/docs/app-server
