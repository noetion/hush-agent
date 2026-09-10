# Local bridge

The bridge lets an agent, runner, multiplexer, or script publish a session to Hush and collect replies. It is a protocol boundary, not automatic support for every existing GUI.

The app binds an ephemeral port on `127.0.0.1` and writes `bridge.json` into its profile directory (`%APPDATA%\Hush`, `~/Library/Application Support/Hush`, or `~/.config/Hush`) containing its URL and a random bearer token. The file rotates each launch. Treat it as a local credential; never commit it or expose its port. Browser-origin requests are rejected. Each registered session also receives a separate key so adapters cannot accidentally poll another session's replies. Any local process that can read the discovery file is within this trust boundary.

## Node adapter

Copy or import `bin/client.cjs` into the runner that already manages your agent.

```js
const { HushClient } = require('./client.cjs');
const client = await new HushClient().connect('My runner', 'Search indexing');
await client.event('working');
// Do the real agent work here.
await client.event('done', 'Index updated. What should I tackle next?');

// Poll once per second, including while idle, to keep the connection alive.
for (const message of await client.replies()) {
  await sendToYourAgent(message.text); // your existing session transport
  await client.ack(message.id);
}
```

`HUSH_BRIDGE_FILE` overrides discovery for an isolated profile. Reconnect after Hush restarts; the old token and in-memory sessions are intentionally invalidated.

## HTTP contract

Every request requires `Authorization: Bearer <token>`.

| Request | Body/result |
|---|---|
| `POST /sessions` | `{provider, title, canReply}` → `{id, key}` |
| `POST /sessions/:id/events` | `{status, text?}` |
| `GET /sessions/:id/replies` | `{messages: [{id, text}]}` |
| `POST /sessions/:id/ack` | `{id: messageId}` |

Session routes additionally require `X-Session-Key: <key>`. Status is `idle`, `working`, `waiting`, `done`, or `error`. Polls and events renew a 30-second lease. If it expires, Hush shows offline and disables reply. Send an event to restore status after a temporary gap.

Replies remain in the queue until acknowledged. A successful Send means accepted by the local bridge, not processed by the model. Consumers must deduplicate message IDs because a crash between delivery and acknowledgement can cause a repeat. Persist that deduplication state if your side effects require it. Delivery is not exactly-once. The queue is in memory and is lost on app exit; do not represent it as durable messaging.

The v1 bridge is text/status only. It does not accept arbitrary shell commands, source URLs, executable callbacks, or approval grants. Integrations that need permission decisions should implement a typed provider adapter with request-scoped decisions.

Limits: 100 sessions, 20 unacknowledged replies per adapter, 16,000 characters per reply, 60,000 per event, 128 KB request body, last 100 messages per session. Adapters must stay local to this Windows user; no LAN or remote forwarding is configured.
