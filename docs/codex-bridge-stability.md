# Windows bridge stability repair (2026-09-27)

## Observed incident

The two existing Feishu subscriber processes were alive and their event streams
continued growing. The Codex consumer crashed in a heartbeat callback: rename
of `lark-codex-bridge.status.json` returned EPERM, then the fallback unlink also
returned EPERM. A PowerShell health reader did not share deletion permission.
The scheduled watchdog first saw the bridge healthy and later reported it dead,
without a second recovery attempt. Its cadence was 30 minutes; battery operation
disabled it. This was a consumer/process lifecycle fault, not evidence that the
Feishu WebSocket itself disconnected.

## Changes

- Replace checkpoints atomically, retry transient Windows sharing violations
  for up to 150 ms, and never unlink the previous valid record. Queue/offset
  persistence failures still propagate to the retry loop; they must not be
  treated as successful intake.
- Publish status at most every five seconds. A telemetry write failure is
  contained, recorded by code/time only, and retried at the next publication.
  Health readers share read/write/delete so replacement can proceed.
- The existing watchdog probes first, restores only unhealthy components via
  their existing idempotent launchers, and checks health again. It handles the
  healthy-then-crashed race within the same cycle. A global mutex excludes
  overlapping watchdog runs; no new event subscription is introduced.
- Recovery has three bounded attempts with delay/jitter, durable 1–10 minute
  cooldown after repeated failure, and alerts at most once per 30 minutes.
  `state/watchdog.json` records results without conversation content. Queue
  delivery stalls are reported separately and do not trigger blind reinjection.
- `configure-feishu-watchdog.ps1` updates the existing scheduled task to a
  one-minute cadence, catch-up after missed execution, battery operation,
  non-overlap, and task-failure retries. It preserves the principal and action.

## References inspected, not imported dependencies

- [Lark Node SDK WSClient at 394c830](https://github.com/larksuite/node-sdk/blob/394c83092395a51402ee408b751d7f9fb05f5518/ws-client/index.ts):
  ping/pong liveness, reconnect generations, and cleanup/error handling of old
  sockets. Liveness must not confuse an idle conversation with a dead socket.
- [OpenClaw Feishu transport at ea07d71](https://github.com/openclaw/openclaw/blob/ea07d7145f68058fa252940276df4218e3af8d7d/extensions/feishu/src/monitor.transport.ts):
  an outer reconnect cycle, lifecycle status, cleanup, and abortable delay after
  terminal connection failure.
- [OpenClaw channel health monitor at ea07d71](https://github.com/openclaw/openclaw/blob/ea07d7145f68058fa252940276df4218e3af8d7d/src/gateway/channel-health-monitor.ts):
  one recovery owner, cooldown and restart budget to avoid restart storms.

The installed Lark CLI remains responsible for its existing socket. This repair
does not claim to add native pong telemetry to that CLI or to prove recovery of
every possible network failure. `healthy` remains a process/consumer-heartbeat
check; matching rollout markers are still the delivery evidence. Machine sleep,
shutdown and unavailable networks cannot provide continuous online service.

## Validation and deployment

Run `node --test daemon/*.test.mjs`. The storage test uses a real Windows file
handle that denies delete sharing, proves the old state survives, and proves
publication recovers after release. The watchdog fixture reproduces the exact
probe race, checks that healthy subscribers are untouched, and verifies durable
cooldown after persistent failure. Existing burst/media/restart tests remain.

Back up changed runtime files and export the existing task XML before deployment.
Deploy the verified, pushed revision into the existing daemon directory, restart
only the exact bridge worker, and update the existing scheduled task. Keep the
durable inbox and cursors. Compare deployed file hashes with the committed source.
Inspect actual task results, worker identity, publication errors and pending jobs.
Do not replay previously submitted messages merely to test recovery.
