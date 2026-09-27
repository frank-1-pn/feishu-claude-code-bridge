# Message reaction feedback

The bridge adds native Feishu reactions to the original authorized user message.
It keeps the text receipt quiet and reuses the existing subscriptions and CLI bot
profiles. The implementation uses [Feishu's reaction API](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)
and follows the lifecycle approach of [OpenClaw's typing indicator](https://github.com/openclaw/openclaw/blob/main/extensions/feishu/src/typing.ts).

| Durable state | Native emoji | Meaning |
|---|---|---|
| Queued/submitted, no rollout marker | `OnIt` | Received and queued; model ingress is not yet confirmed |
| Rollout user marker seen, reply pending | `Typing` | Processing or preparing delivery |
| Reply delivery checkpoint committed | `DONE` | This reply was delivered, not a guarantee that the underlying task succeeded |
| Failed task or permanently blocked reply | `ERROR` | This turn needs attention; ordinary error notices remain available |
| Waiting timeout or rollout read failure | `OneSecond` | Delayed, still being followed |

Only matching bot/profile/chat/sender/thread jobs are eligible. Synthetic card
callbacks have no actual user message to react to and are excluded. Installation
does not backfill old completed messages. Active indicators older than 24 hours
are cleared; completed acknowledgements may remain. Set the private binding's
`reaction_feedback` to `false` to stop adding new reactions and clean up active
ones on the next bridge reload.

`codex-bridge-reactions.mjs` has a separate per-bot feedback lane. Main intake,
model execution, text/card/file delivery do not wait for reaction requests. Each
request has a 15-second timeout. Normal state transitions add once and remove
the previous owned reaction; no periodic re-add/keepalive is used.

Private journals under `daemon/state/reactions-v1/<bot>/` retain desired states,
create intents and returned reaction IDs. After an uncertain create or restart,
the bridge lists reactions and adopts only the matching current app's reaction
before retrying. It never removes another app's or a user's emoji. In-flight
updates recheck desired state so a late processing response cannot overwrite a
delivered acknowledgement. Corrupt journals fail closed and do not block the
main message lane. Rebinding cannot replay old feedback into a new conversation.

Read/write permissions are checked with bot identity. Minimal dedicated scopes
are `im:message.reactions:read` and `im:message.reactions:write_only` (broader IM
scopes can also authorize these APIs). Permission failures pause feedback calls
for five minutes across that bot's queue; transient failures retry with backoff.
Permanent message/validation failures stop retrying. These failures never rerun
a model task or produce a false DONE marker.

The health report exposes `reaction_pending_count`, `reaction_blocked_count`,
`reaction_error_count`, `reaction_last_error`, `reaction_pause_until` and
`feedback_healthy`. This feedback status is separate from transport/delivery
health and does not cause the watchdog to restart a healthy connection.

## Validation

- Nine focused tests cover real inbox delivery checkpoints, pending reply
  failures, uncertain creates, restart adoption, other-operator preservation,
  late in-flight completion, burst permission backoff, expiry, rebinding, corrupt
  journals, synthetic callbacks, private identity resolution and bot timeouts.
- Full bridge regression: 122 tests passed.
- Both configured bots successfully created, read and removed a temporary native
  reaction on an authorized message; cleanup was verified through the list API.
- Live automatic state changes and client appearance await deployment and a
  real-message check; API preflight alone is not an end-to-end acceptance claim.
