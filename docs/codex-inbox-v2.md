# Codex durable inbox and media delivery

The original bridge awaited the final answer before reading the next message.
It dropped non-text events. V2 separates intake, receipts, submission, rollout
observation and reply sending into independent per-bot loops. An open Orca
terminal receives subsequent messages without waiting for a previous answer.
When no terminal exists, headless resume remains single-writer; intake continues
and later messages remain durably queued until that writer finishes.

## Guarantees and boundaries

- Continue consuming the existing NDJSON subscription; do not create a second WebSocket.
- Persist the authenticated event under `daemon/state/codex-inbox-v2/<bot>/` before advancing intake offsets.
- Validate both chat and sender. Message IDs deduplicate across restart.
- Persist submitted state before the external call. On uncertain submission,
  reconcile the message marker in the target rollout; never blindly rerun tasks.
- A rollout marker proves model ingress. `task_complete` or an explicit final
  message supplies the answer. Messages consumed in the same turn share an outbox
  key and one final reply; separate turns have distinct answers.
- Retry output with a stable Feishu idempotency key per chunk. No reasoning output
  is forwarded. Long responses are split and long input uses a UTF-8 local file.
- Download images/files/embedded post media through the bound bot identity with
  the proxy disabled. Use fixed generated filenames under per-message directories,
  verify resolved containment and size (50 MiB maximum accepted file), and pass
  actual local paths to Codex. Images explicitly request `view_image`.
- CLI requests are bounded. Failed preparation retries with backoff three times,
  then retains a failed record and gives an explicit notice. This does not block
  later messages. Unsupported formats are reported, never silently discarded.
- `healthy` remains transport/process health for compatibility with supervisors.
  `delivery_healthy`, queue counts, stalled delivery and `last_delivered_at` expose
  application delivery separately. Timeout notices do not cancel tracking.
- State includes private message content: keep it outside Git. Completion records
  are retained for dedup; do not purge them during an active migration.

## Update and recovery

Back up live source, bindings, status, offsets and old outboxes. Stop only the
exact bridge worker after verifying its PID, command line and instance; leave
subscribe daemons and Codex writers running. Deploy the verified files.

Run `node daemon/migrate-codex-inbox.mjs <live-bindings.json>` to inspect the
migration; `--apply` adopts authorized recent backlog and any already-submitted
turn without re-injecting. Start using the existing launcher and verify source
hashes, process identity, counts and actual rollout markers.

For rollback, stop the exact V2 worker first. Preserve its entire inbox and both
generations of offsets/outboxes. Do not simply restore old offsets: intake offsets
no longer mean final replies completed. Reconcile submitted/completed message IDs
before enabling a V1 worker, or it can duplicate tasks or skip pending messages.

## Validation

`node --test daemon/codex-bridge-*.test.mjs`

Tests cover bursts before any final, distinct-turn reply correlation, queued and
submitted restart recovery, duplicate IDs, uncertain CLI submission, late replies,
partial UTF-8 lines, send retries, attachment failure isolation, binary download
cache, path escape/size rejection and long text preservation. Run tests with
explicit filenames if the platform does not expand wildcards.

## Design references (reviewed 2026-09-26)

- [Lark Channel SDK](https://github.com/larksuite/channel-sdk-node): normalized
  message/resource descriptors, per-chat queues and batching; retain a single
  connection per app.
- [OpenClaw Feishu ingress](https://docs.openclaw.ai/channels/feishu/setup):
  authenticated durable acceptance before dispatch and restart-safe replay guards.

The implementation is local to this bridge; no external project code was copied
and no extra channel plugin was installed.
