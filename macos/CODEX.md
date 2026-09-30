# macOS Codex bridge development

This port extends the shared Codex bridge, not the legacy Claude Monitor flow.
Private app credentials stay in the local CLI configuration. Chat/sender/thread
bindings and event queues stay outside Git. No bot is activated by development.

Implemented:
- Resolve a held Codex writer lock with macOS flock/lsof and map its process
  ancestry to exactly one Orca PTY. Missing or ambiguous matches fail closed.
- Connect to the existing Orca daemon Unix socket. Send prompts using the public
  Orca `terminal send --text --enter` interface and retain rollout-marker proof.
- Use CLI 1.0.97 `event consume` processes sharing one bus per profile. Keep stdin
  open; parse readiness and structured error metadata without logging secrets.
- Convert flattened card callbacks to the original bridge event shape.
- Keep the original persistent inbox, exact chat+sender authorization, attachment
  outboxes, native replies, deduplication and public-only progress forwarding.
- Provide launchd start/stop/check/status via `daemon/macos-service.mjs`.
- Canonicalize macOS temporary paths to account for `/var` -> `/private/var`.

Run offline tests:

```sh
node macos/test-codex.mjs
```

After explicit activation authorization and deployment of a reviewed fixed
revision, create a private `daemon/codex-thread-bindings.json` from the example.
Set `runtime.lark_cli_exe` to the actual CLI file, `lark_send_script` to the
installed `lark-send.mjs`, and every identity/path to the real approved value.
Use an existing real Codex thread; never infer ownership from a terminal title.

```sh
node daemon/macos-service.mjs check
node daemon/macos-service.mjs start
node daemon/macos-service.mjs status
node daemon/macos-service.mjs stop
```

Status does not claim verified transport health. Readiness proves subscription
startup, not fresh SDK pong. The initial version lacked SDK pong instrumentation; the dedicated macOS
bus CLI and verification path below supersede that limitation.
Consumers retry locally after exits and launchd recovers their supervisor.

Completed local probes: app configuration, actual message ingress, existing
writer-to-PTY resolution, configuration-only validation and offline tests.
Deferred by user: activating bindings, prompt injection, final reply delivery,
real card clicks and real attachment delivery. Initial development was not activated. Current authorized deployment is gated
on final delivery and full queue idleness. Optional cloud/task/voice
features retain upstream behavior; they require separate live permission tests.

## Reliability changes (2026-09-30)

`node daemon/macos-service.mjs harden` installs one launchd watchdog with login
startup and restart-on-exit. It adopts existing healthy worker/subscriber PIDs
only after command identity checks, avoiding interruption of a live turn.
The watchdog checks the worker's real heartbeat, CLI bus and registered
consumers. Missing workers recover with bounded backoff; a bus missing for more
than 60 seconds requests graceful subscriber recovery. A card-only permission
failure cannot force a working text subscriber to restart. Subscriber failures
retry locally; SIGTERM closes stdin and then requests graceful termination.

No recovery resets event offsets, durable inbox, reply records or bindings.
Initialization creates an empty source and initial byte cursor before starting
consumers, preventing the first new message from being skipped as history.

The watchdog fixture starts real local child processes, proves adoption of a
healthy worker, terminates it and checks recovery plus unchanged queue bytes.
It does not interrupt the actual live bot. Current deployment is pending a
fixed tested pushed revision as required by the repository instructions.
SDK pong detection is covered below. Bus readiness and chat activity still
never substitute for verified socket health.

## SDK heartbeat and independent model diagnostic entry

The macOS pinned bus CLI is built by `scripts/build-lark-heartbeat-macos.py`.
Sources: CLI `7beffb086d7fa3c5b843d8affa7c089f49cfc65e`, SDK
`efd7ae4c25f7187100b04b6018469aba2bfac99d`. The observer is initialized in
FeishuSource.Start in the bus process, not package init in every consumer.
Raw SDK logs are suppressed, lifecycle notifications retain safe fixed hints,
and only real SDK pong verifies a connection. PID/profile/start identity and
bounded unanswered-ping/reconnect/frozen-loop deadlines are checked locally.
The global CLI is unchanged. The dedicated subscriber binary and its hash
manifest are host-private. A real loopback WebSocket test sends one real pong,
then drops subsequent pong replies while the SDK continues pinging a live socket.

`deploy-macos-when-idle.py` waits for all recorded queues and offsets, checks
exact process identity and the pushed revision, backs up runtime files, gracefully
stops the exact old components and bus, copies their durable state, installs
runtime code outside Git, and starts the launchd watchdog. It records real-pong
verification and retains post-deployment round-trip validation as pending.

`macos-fallback.mjs` is a separate model-diagnostic entry point. It remains
inactive until a user supplies and authorizes endpoint, model and private API-key
path. It sends only allowlisted health metadata. Model advice cannot become a
shell command or interrupt a healthy component/active Codex writer. Provider
setup and automatic invocation are pending; the model does not currently run.
