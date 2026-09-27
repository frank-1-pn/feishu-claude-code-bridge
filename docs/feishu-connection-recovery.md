# Connection heartbeat and recovery

The existing subscriber remains the only event subscription for each bot. The
pinned CLI/SDK adapter exports real SDK ping/pong observations to a private
snapshot. It does not poll chat traffic, send heartbeat messages, or copy keys.
See [source pins and hooks](../patches/lark-ws-health/README.md).

## Health and recovery

`status-codex-bridge.ps1` matches snapshot PID, profile and process creation time.
Only a pong on the current connection can set `socket_verified=true`.

| Condition | Recovery threshold |
|---|---|
| A ping has no pong | 30 seconds from the oldest unanswered ping |
| Ping loop freezes | Last pong older than 2 × server ping interval + 30 seconds |
| SDK remains disconnected/reconnecting | 60 seconds |
| A new connection never gets its first pong | Server ping interval + 30 seconds; reconnect flapping does not reset this deadline |
| Missing, corrupt or wrong-process snapshot | 60 seconds after process creation |

The supervisor probes every minute, adding up to 60 seconds under normal
scheduler operation. With a 120-second server interval, silent loss is normally
detected within 210 seconds; the frozen-loop bound is 330 seconds. Computer sleep,
scheduler delays and existing retry cooldown can extend these times.

`healthy` permits bounded startup/reconnect grace for recovery decisions;
`transport_healthy` requires fresh pongs for all bots. `delivery_healthy` also
checks queue failures and stalls. None alone proves model ingress: verify the
real event, original thread's rollout marker and final reply.

`ensure-bot.ps1` restarts only the exact subscriber/profile that needs recovery,
using the existing launcher. It preserves NDJSON logs, offsets, inbox, bindings
and reply checkpoints. CLI singleton locks and the per-bot mutex remain active.
Persistent failures retain exponential cooldown; warnings wait for three failed
checks and have a 30-minute rate limit.

## Build and install

```powershell
python scripts/build-lark-heartbeat.py --go <go.exe> --build-dir <new-build-directory>
```

The build uses fixed upstream revisions, exact hooks and subscriber package
tests. It writes `lark-cli.exe` and `build-manifest.json`. On Windows, upstream's
Linux-path fixture `TestParseRoutes_RejectsAbsolutePath` is excluded and recorded
in the manifest: it also fails on the unchanged upstream checkout. All local
heartbeat tests run. Do not count the excluded upstream test as passed.

After testing, committing and pushing the source, install the executable as
`daemon/bin/lark-cli.exe` and the manifest as `daemon/subscriber-runtime.json`.
The launcher checks SHA-256 before starting it. Back up the previous runtime,
check queues, stop one exact subscriber, then invoke `ensure-bot.ps1` with
`-SkipSessionBinding`. Never use `--force` or duplicate subscriptions. Roll back
runtime files and restart one bot at a time if needed. Global CLI and credential
configuration stay unchanged. Build outputs and runtime state stay outside Git.

## Invisible scheduled startup

Run `configure-feishu-watchdog.ps1` from the installed runtime directory. It
retains the task principal and one-minute schedule, using `wscript.exe //B
//NoLogo run-watchdog-hidden.vbs` as the GUI entrypoint. The wrapper starts
PowerShell hidden at process creation, waits and propagates its exit code,
preserving overlap control and failure reporting. The executable fixture checks
waiting, spaces in paths, missing scripts and failure codes. Verify a real task
run and visible windows too: direct PowerShell with `-WindowStyle Hidden` flashed.

## Scoped network acceptance

`scripts/feishu-network-probe.mjs` is a loopback HTTP CONNECT relay. TLS remains
end-to-end encrypted; only byte/connection counters are retained. It can discard
real traffic while the client process/socket stays alive, then close damaged
tunnels to permit a clean reconnect. Faults expire automatically. It changes no
system proxy settings; production targets are Feishu/Lark hosts on port 443.

For an authorized test, write private `state/network-probe-<bot>.json` with
`proxy` set to the local relay and `expires_at_ms` at most 15 minutes ahead. Only
that bot's next subscriber receives the route. Expired, malformed,
credential-bearing or non-loopback routes are ignored. During cleanup, remove
the file, close the relay and restart the test bot through the ordinary launcher.
Retain all logs and offsets; do not commit probe configuration/private evidence.

Acceptance needs a positive pong, discarded real TCP bytes with the subscriber
alive, expired heartbeat, automatic supervisor recovery, and a fresh pong after
restoration. Then send a real bound-chat message and verify its original-thread
marker and delivered final reply. Report unfinished client-side checks honestly.
