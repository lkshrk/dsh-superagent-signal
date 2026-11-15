# Architecture

dsh-superagent-signal is a cordis plugin for DSH. It registers one Source kind, `signal`, with dsh-superagent and runs two loops against the signal hub: intake and notices. It holds no database of its own: all state goes through the Source context dsh-superagent provides.

## Context

```mermaid
flowchart LR
  owner([Owner in the Signal group])
  signal[Signal]
  hub[signal hub<br/>consumer dsh]
  subgraph dsh[DSH process]
    plugin[dsh-superagent-signal]
    superagent[dsh-superagent<br/>orchestrator]
  end

  owner -- messages, quotes --> signal
  signal <--> hub
  plugin -- GET /v1/messages --> hub
  plugin -- POST /v1/send --> hub
  plugin -- GET /v1/attachments --> hub
  plugin -- Triggers --> superagent
  superagent -- replies, notices --> plugin
  superagent -- tickets, health --> plugin
```

## Components

| File | Role |
| --- | --- |
| `src/index.ts` | Plugin entry. Builds one `HubClient`, registers the Source kind and runs `watchSignal` inside a cordis effect. |
| `src/kind.ts` | The Source kind: panel fields, scope, Channel, thread context (quoted parent, images), Policy. |
| `src/config.ts` | `SignalConfigSchema` and group id normalization. |
| `src/hub.ts` | `HubClient`: pull, send and attachment download, with the bearer token read from `tokenFile` on every request. |
| `src/watch.ts` | `watchSignal`: the two loops and the `signal` health entry. |
| `src/intake.ts` | `pollSignal`: one pull, routing to threads, Trigger building. |
| `src/channel.ts` | `sendSignal`: dsh-superagent's messages to the hub, recorded so a retry does not post again. |
| `src/notices.ts` | `noticeRound`: stuck ticket notices, health notices, and the batch round. |
| `src/batch.ts` | The current batch of tickets: who started and ended, and the start and summary messages. |
| `src/labels.ts` | Origin labels, quoted titles, outcome words and pull request links. |
| `src/attachments.ts` | Attachment lines in Trigger text and image reading for assessments. |
| `src/state.ts` | State keys, the map and its pruning. |
| `src/types.ts` | The parts of dsh-superagent's Source interface the plugin uses, written out structurally. |

`index.ts` runs the loops inside a cordis effect. Disposing the plugin aborts both and unregisters the kind. DSH ends its process on an unhandled rejection, so an error that escapes the loops becomes the Source's health instead.

## The loops

`watchSignal` waits for dsh-superagent to be ready. When the deployment is not configured, it reports `paused` and exits. When dsh-superagent lacks `admits`, `health`, `tickets.changed` or `tickets.attachThread`, it reports `error` naming them and exits without pulling. Otherwise it runs both loops until aborted.

**Intake** repeats back to back; the hub's long poll (`pollWaitSeconds`) paces it, and with `pollWaitSeconds: 0` an empty page is followed by a 1 second wait:

1. Read the current config. Report `paused` when the Source is off, or `hubUrl`, `tokenFile` or `groupId` is empty or invalid, and check again after 5 seconds.
2. Pull once after the stored cursor (`pollSignal`). With no cursor yet, the hub starts at its head: older messages are not work for the Source.
3. For each message, in order: route it to a thread, hand its Trigger to dsh-superagent, then store its `seq` as the cursor. A crash mid-page replays at most the message being handled, and its fixed Trigger id makes that harmless.
4. Store the page's `next`, unless it would move the cursor back without a `reset`.
5. Report `ready` with the counts.

A failed pull, including a config read that throws, waits 5 seconds. A 401 makes health `error` at once; any other failure from the third in a row, or at once when it follows a 401. A pause resets the count.

**Notices** run every 5 seconds while the config is complete (`noticeRound`):

1. With `notifyTickets`, read every ticket changed since the ticket cursor through `tickets.changed`, page by page:
   - post a question, block or failure at once, once per transition;
   - add a ticket whose stage first shows a worker on it (any stage but `working`/`queued` and `ended`) to the current batch as started, and a ticket that ended as ended;
   - store the batch, then the cursor, after each page.
2. With `notifyTickets`, settle the batch: post the start message once no ticket started for `batchSettleSeconds`; post the summary and drop the batch once every ticket ended and none ended for `batchSettleSeconds`; post a partial summary when an unreported end is `batchMaxHours` old while tickets still run. A ticket `tickets.get` no longer finds leaves the batch first. A ticket seen open again after it ended (a person resumed it) loses its end and counts as running; its next end replaces the old one.
3. With `notifyHealth`, read `health()` and post an entry's failure once it stayed `error` for `healthGraceSeconds`, and its recovery.

An exception in a notice round is logged by its name only and the loop goes on; it never stops intake.

The ticket cursor and the batch survive restarts. A start or summary message's id is `signal:batch:<batch id>:start:<hash>` or `signal:batch:<batch id>:summary:<hash>`, where the batch id is when the batch began and the hash is the first 12 hex digits of the SHA-256 of the message's sorted ticket ids (with each end's outcome and time, and the running tickets, for a summary). A crash between posting and storing the batch posts the same content under the same id, and dsh-superagent's outbox drops the repeat; content that changed meanwhile gets a new id and goes out. After a long dsh outage the next start or summary covers what happened meanwhile. The first round ever only stores the cursor at now.

## Threads and the map

Every message the Source takes in or sends is mapped from its Signal timestamp to a thread, and to a ticket when it belongs to one. A quote or an edit looks up the quoted or edited timestamp:

- found: the message joins that thread;
- not found, or older than the map horizon: a quote starts a new thread; an edit is ignored.

Either way a quote's Trigger text ends with `> quoted: <quoted text>`.

dsh-superagent's replies, including those sent before a ticket exists, and its ticket notices are mapped when sent: to their thread, and to their ticket when they have one. Health notices and the batch's start and summary messages are not mapped. A notice about a ticket from another Source lives on the thread `<group>:ticket:<ticket id>`. When the owner quotes it, the Source adds that thread to the ticket with `tickets.attachThread` before handing the Trigger in, so the answer reaches the ticket.

The map horizon is 14 days, the hub's retention. Times the Source stores and compares are the hub's `receivedAt` or the local clock, never the sender's Signal timestamp, which serves only as an identifier. At most once an hour, a pull prunes map and send records older than the horizon, and notice records of tickets that are gone or ended more than 14 days ago. An open ticket keeps its record however long it waits.

## Stored state

All keys live in the Source's state.

| Key | Value | Written by |
| --- | --- | --- |
| `signal-cursor` | number: the hub `seq` to pull after | intake |
| `signal-map:<timestamp>` | `{ thread: string, ticketId?: string, at: string }` | intake, Channel |
| `signal-sent:<message id>` | `{ timestamps: number[], at: string }`: the Signal timestamps a dsh-superagent message was posted under | Channel |
| `signal-notified:<ticket id>` | `{ keys: string[], ended?: string }`: the last 20 transitions announced, and the end a summary covered | notices |
| `signal-batch` | `{ id, tickets: [{ id, origin, title, issue?, parent?, epic?, started?, announced?, ended?: { at, seen, outcome, pull? }, reported? }], lastStart?, lastEnd? }`: the current batch | notices |
| `signal-ticket-cursor` | `{ at: string, id: string }`: where `tickets.changed` reads on | notices |
| `signal-health:<entry>` | `{ state: 'error', since: string, notified: boolean }` or `{ state: 'ok' }` | notices |
| `signal-pruned` | string: time of the last prune | intake |

## dsh-superagent members used

The plugin needs dsh-superagent 0.3.0, which added these to the Source context:

| Member | Why |
| --- | --- |
| `admits(actor)` | Checks a sender's UUID or number against the Policy, so the Source takes in only listed people without parsing the Policy itself. |
| `tickets.changed(after, limit)` | Pages through ticket changes with their stage, so ticket notices cover every Source and survive restarts through a cursor. |
| `tickets.attachThread(id, thread)` | Adds the ticket thread of a notice to a ticket from another Source. Unlike `bindThread`, it adds no `follows` entry. |
| `health()` | Reads every health entry, for dependency notices. |

The kind also implements the thread context's `images` and `image` hooks, so an assessment can read Signal images.

## Logging

Log lines start with `dsh-superagent-signal:` and carry ids only: `seq`, kind, Signal timestamp, sender id, ticket id. Tokens, message text and attachment content are never logged.
