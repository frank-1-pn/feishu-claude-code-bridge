# Lark CLI heartbeat instrumentation

This adapter adds a private JSON snapshot to the existing `event +subscribe`
process. It does not create another subscription or change event routing.

Pinned sources:

- [Lark CLI v1.0.39](https://github.com/larksuite/cli/tree/ce5b4f24e1746b83b060a795ef21e28dc2c46e4d), MIT.
- [Lark Go SDK v3.5.4](https://github.com/larksuite/oapi-sdk-go/tree/63a9f9f4133a6789981bb87c9a440bf4cdfe5b1e), MIT.

`scripts/build-lark-heartbeat.py` applies exact hooks to the pinned source,
copies the local logger adapter, tests the subscriber package, builds the CLI,
and records the output hash. The SDK hook exposes only the server's ping
interval. The logger records exact SDK ping/pong and lifecycle signals and
suppresses raw SDK logs, including connection URLs and message bodies.
Existing per-app singleton locks, credentials and NDJSON output are preserved.

Set `LARK_BRIDGE_WS_HEALTH_FILE` and `LARK_BRIDGE_PROFILE` only on the subscriber
process. The snapshot includes PID, start time, connection generation, server
heartbeat interval, and ping/pong times. A local ping alone never verifies the
connection; stale snapshots and snapshots from a prior process must be rejected.

Build outputs, credentials and health snapshots stay outside Git. Upstream
license files remain in each build checkout; the repository stores local
integration code rather than a copy of the full upstream SDK or CLI.
