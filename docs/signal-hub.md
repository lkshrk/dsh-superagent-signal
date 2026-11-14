# Signal hub

The plugin talks to the [signal hub](https://github.com/lkshrk/signal-hub) as its consumer `dsh`, over three endpoints of the hub's generic API. Every request carries `Authorization: Bearer <token>`, with the token read from `tokenFile` each time. It uses no other endpoint, no Server-Sent Events and no compatibility listener.

## Pull: `GET /v1/messages`

`GET /v1/messages?after=<cursor>&wait=<pollWaitSeconds>&limit=<pollLimit>`, with a timeout of `pollWaitSeconds` plus 15 seconds.

- No stored cursor: `after` is left out and the hub starts at its head.
- `next` becomes the cursor. The cursor is also stored after each message, so a crash replays at most one.
- `missed` counts messages older than the consumer's `maxReplayAge`. The Source adds it to health and logs it.
- `reset: true` means the hub's log was wiped; the hub read from its oldest message. The Source stores the new `next` even though it is lower, and names the time in health.
- Kinds `message` and `edit` from the configured group can become Triggers. `reaction`, `poll_vote` and unknown kinds are counted as ignored.
- A response that does not match the expected shape counts as a failed pull.

## Send: `POST /v1/send`

```json
{ "recipient": "<internal group id>", "text": "…", "quote": { "timestamp": 1763114400000, "author": "<uuid or number>" } }
```

`quote` is present when the Channel names the message answered; ticket notices for other Sources and health notices have none. The timeout is 30 seconds.

The answer's `timestamps` are recorded under the message id and mapped to the ticket, so a quote of the reply finds its way back. `failures` are logged by recipient id. An answer with no timestamp counts as a failure.

## Attachments: `GET /v1/attachments/{id}`

Only for images an assessment reads. The download stops at the smallest of `attachmentMaxBytes` and dsh's image limits, checked against `Content-Length` and while streaming. The `Content-Type` must still match the type listed in the Trigger. The timeout is 60 seconds.

## Errors

The hub answers errors as `{"error":"<text>"}`. The Source uses that text, with the status.

| Status | Pull | Send | Attachment |
| --- | --- | --- | --- |
| 400 | Failed pull | Dropped: the message can never succeed; logged | Read fails |
| 401 | Health `error` at once: `The hub refused the token (401)`; retried every 5 seconds | Thrown; dsh-superagent retries | Read fails |
| 403 | Failed pull | Thrown; dsh-superagent retries, and its `reply` health shows `recipient not allowed` until the consumer lists `groupId` | Read fails |
| 404 | Failed pull | Thrown; retried | `attachment no longer available` |
| 413 | Failed pull | Dropped; logged | `attachment exceeds <n> bytes` |
| 429 | Failed pull | Thrown; retried | Read fails |
| 502 | Failed pull | Thrown; retried | Read fails |
| Timeout, connection error | Failed pull | Thrown; retried | Read fails |

A failed pull waits 5 seconds. From the third in a row, health is `error` with `<n> failed polls in a row; last: <error> (<status>)`.

A missing or short token file never reaches the hub: the request fails with `the token file cannot be read` or `the token file holds fewer than 32 characters`.

Delivery to Signal is at least once. If dsh stops after the hub sent a message but before the Source recorded it, the retry posts it again.
