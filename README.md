# dsh-superagent-signal

A Signal Source for [dsh-superagent](https://github.com/lkshrk/dsh-superagent), through the [signal hub](https://github.com/lkshrk/signal-hub).

The owner writes in one Signal group. Each message from someone on the Policy's `allowed` list becomes a dsh-superagent Trigger. dsh-superagent's replies go back into the group, quoting the message they answer. To answer a reply, or a notice, quote it.

The Source also:

- posts one message when tickets start and one summary when they all finished, and a notice at once when a ticket asks a question, is blocked or failed;
- posts a notice when another Source or sync entry stays in `error`, and again when it recovers;
- lists Signal attachments in the Trigger text and lets an assessment read the images among them.

More detail:

- [Architecture](docs/architecture.md): the two loops, stored state, the map horizon, the dsh-superagent members used.
- [Configuration](docs/configuration.md): every key, the Policy, an h-cloud example, installation from the image or tarball.
- [Signal hub](docs/signal-hub.md): the three hub endpoints used and how each error status is handled.

## Requirements

- dsh `^0.2.1-alpha.2 || ^0.2.2-0` (the `engines.dsh` range) with the dsh-superagent plugin.
- dsh-superagent `>= 0.3.0` (`lkshrk/dsh-superagent`). The Source checks this at runtime, not through `engines`. The Source registers through its `orchestrator` service and uses members that older versions lack. On an older one it stays in health `error` and takes nothing in.
- A [signal hub](https://github.com/lkshrk/signal-hub) with a consumer named `dsh` that lists exactly the configured group, with `maxReplayAge: 14d`.
- Node.js `^22.19.0 || >=24.0.0`.

A Source kind is registered once per dsh-superagent. Install the package once.

## Install

Each release attaches `dsh-superagent-signal-<version>.tgz` to its GitHub release. Install it into the profile:

```sh
dsh plugin --profile <profile> add "file:/path/to/dsh-superagent-signal-<version>.tgz"
```

Each release also pushes `ghcr.io/lkshrk/dsh-superagent-signal:<version>`, a `scratch` image holding only that tarball at `/`, for mounting as a Kubernetes image volume. The release notes end with the digest to pin:

```text
Image: ghcr.io/lkshrk/dsh-superagent-signal:<version>@sha256:…
```

The package's bundle layer (`cordis.patch.yml`) inserts the plugin disabled. Enable it in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-superagent-signal
  disabled: false
```

## Configure

Set the Source in the dsh-superagent panel, or in dsh-superagent's plugin configuration under `managed`:

```yaml
managed:
  sources:
    signal:
      enabled: true
      config:
        hubUrl: http://signal-hub.tools.svc.cluster.local:8080
        tokenFile: /var/run/secrets/signal-hub/dsh
        groupId: group.<base64 of the internal id>
  policy:
    sources:
      signal:
        allowed:
          - id: 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b
            name: Owner
          - id: "+4915112345678"
```

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `hubUrl` | string | `""` | Hub base URL: empty or `http(s)://…` without a trailing `/`. |
| `tokenFile` | absolute path | `""` | File with the hub consumer `dsh`'s token, at least 32 characters after trimming. An account field. |
| `groupId` | string | `""` | The group: its internal id (base64 of 32 bytes) or `group.<base64>`. Stored as given, compared as the internal id. |
| `pollWaitSeconds` | integer, 0–60 | `30` | The hub's long-poll `wait`. Advanced. |
| `pollLimit` | integer, 1–500 | `100` | Messages per pull. Advanced. |
| `notifyTickets` | boolean | `true` | Start, stuck and summary messages about tickets. Advanced. |
| `notifyHealth` | boolean | `true` | Notices when a dependency fails or recovers. Advanced. |
| `healthGraceSeconds` | integer, 0–3600 | `60` | How long an entry must stay `error` before its notice. Advanced. |
| `attachmentMaxBytes` | integer, 0–26214400 | `10485760` | Larger inbound attachments are listed, not fetched. Advanced. |
| `batchSettleSeconds` | integer, 0–3600 | `120` | How long no ticket may start, or end, before the start message, or the summary. Advanced. |
| `batchMaxHours` | integer, 1–48 | `4` | How long an ended ticket waits for its summary while others still run. Advanced. |

[Configuration](docs/configuration.md) explains each key in full.

Unknown keys are rejected. The Source stays `paused` while `hubUrl`, `tokenFile` or `groupId` is empty, or `groupId` is not a valid group id.

### Policy

Only people in the Policy's `allowed` list originate work. Each `id` is a Signal ACI UUID in lower case, or an E.164 number. A message is taken in when dsh-superagent admits its sender's UUID or number. Messages from anyone else are counted and logged by sender id, and dropped. The Source has one admission row, `chat`, and takes in nothing from people who are not listed.

## How threads and quotes work

| You write | Thread | Trigger |
| --- | --- | --- |
| A message that quotes nothing | A new thread, `<group>:<timestamp>` | `signal:<sender>:<timestamp>` |
| A quote of your own earlier message, or of dsh's reply to it | That message's thread | as above |
| A quote of a notice about a ticket that did not start in Signal | The ticket's thread, `<group>:ticket:<ticket id>`, which the Source attaches to the ticket | as above |
| A quote of anything older than 14 days, of a health notice, or of a message the Source never saw | A new thread | as above |
| An edit | The edited message's thread; the text starts with `(edited)` | as above, with the edit's timestamp |

A Trigger for a quote, except an edit, ends with `> quoted: <quoted text>`, so the worker sees which message it answers.

The Source remembers which thread each message belongs to for 14 days (the map horizon), counted from when the hub received it. Reactions, poll votes, edits of unknown messages and messages from other groups are ignored.

Each Trigger's Channel is the message itself: dsh-superagent's reply quotes it. Fixed ids make a replay after a restart harmless.

Attachments are listed in the Trigger text, one line each, such as `[attachment signal:<id> shot.jpg image/jpeg 48213 bytes]`. One over `attachmentMaxBytes` is marked `(too large to read)`. An assessment on an image-capable model can read the PNG, JPEG, WebP and GIF images among them.

## Notices

With `notifyTickets`, the Source watches every ticket in dsh-superagent, whatever Source it started from. Signal is for special cases: tickets that start or finish together get one message, not one each.

| Change | Message | When |
| --- | --- | --- |
| Tickets start: a worker is on them | `Started: <n> tickets` and one line `<origin> "<title>"` per ticket | Once no other ticket started for `batchSettleSeconds` |
| The ticket asks a question | `Question on <origin> "<title>":` and the question | At once |
| A worker reports it blocked | `<origin> "<title>" is blocked:` and the report | At once |
| A worker reports it failed | `<origin> "<title>" failed:` and the report | At once |
| Every ticket of the batch ended | `Finished: <n> tickets` and one line per ticket: `is done`, `is merged`, `was closed without merging`, `was dropped: nothing to do` or `was stopped by a person`, with the link of its own pull request when it has one | Once no other ticket ended for `batchSettleSeconds` |
| Tickets ended while others still run | `<ended> of <all> done, still running: …` and a line per ticket ended since the last summary | When the oldest of those ended `batchMaxHours` ago |

`<origin>` is `Signal request`, `Linear ENG-12`, `GitHub <url>`, `Feishu` or the Source's name. A Linear title that starts with its identifier (`ENG-12: Fix login`) is quoted without it.

```text
Started: 3 tickets
Epic ENG-10:
  Linear ENG-11 "Add form"
  Linear ENG-12 "Wire API"
Linear ENG-20 "Fix footer"
```

```text
Finished: 3 tickets
Epic ENG-10 "Login revamp": 2 of 2 sub-issues merged
  Linear ENG-11 "Add form" is merged: https://github.com/o/r/pull/11
  Linear ENG-12 "Wire API" is merged: https://github.com/o/r/pull/12
Linear ENG-20 "Fix footer" was closed without merging
```

- The sub-issues of a Linear epic are listed under it. The count covers the sub-issues in the batch, not every sub-issue in Linear. When the epic is a ticket of the batch too, its title shows on the group's line, and in the summary its own outcome: `Epic ENG-10 "Login revamp" is done, 2 of 2 sub-issues merged`.
- A ticket that ends without a worker ever starting on it, such as one dropped at assessment, shows only in the summary.
- A question, block or failure inside the settle window arrives before the start message that lists its ticket.
- The final summary waits for every ticket of the batch. One ticket that stays open, such as one waiting on review, holds it back; meanwhile a partial summary of the tickets that ended goes out every `batchMaxHours`.
- A ticket a person resumes after it ended counts as running again. Its later end replaces the earlier one in the summary. Resumed after its summary went out, it starts a new batch with its own start message and summary.
- A ticket that no longer exists in dsh-superagent leaves the batch.
- Start and summary messages go to the group without a quote. Quoting one starts a new request.
- A question, block or failure of a ticket that started in Signal is a reply to the request that started it. A ticket from another Source gets it in the group without a quote; quote it to answer, and the answer goes to that ticket.
- No message announces a single ticket's end. A Signal request still gets dsh-superagent's own reply on it.
- On its first start the Source announces nothing from before; it starts watching from then on.
- After a long dsh outage the next start or summary covers what happened meanwhile.

With `notifyHealth`, the Source watches the health entries of the other Sources and sync jobs (not dsh-superagent's own effects, and not its own entry). An entry that stays `error` for `healthGraceSeconds` gets `dsh: <entry> is failing: <detail>` (at most 300 characters); when it is `ready` again, `dsh: <entry> works again.` Health notices start no ticket; quoting one starts a new request.

## Health

The Source reports one health entry, `signal`.

| State | Detail | When |
| --- | --- | --- |
| `paused` | `Waiting for the deployment check` | dsh-superagent's deployment is not configured. The loops exit. |
| `paused` | `Off` | The Source is switched off. |
| `paused` | `Set the hub URL, token file and group id` | One of the three is empty, or `groupId` is not a valid group id. |
| `error` | `This dsh-superagent version lacks <members>; the Signal Source needs dsh-superagent 0.3.0 or later` | dsh-superagent lacks `admits`, `health`, `tickets.changed` or `tickets.attachThread`. Nothing is pulled. |
| `error` | `The hub refused the token (401)` | At once when the hub answers 401. |
| `error` | `<n> failed polls in a row; last: <error>` | From the third failed pull in a row, or at the first one after a 401. |
| `ready` | `<taken> taken in, <refused> from people not on the list, <ignored> ignored, <posted> notices` | After each successful pull. Adds `; <n> older than the hub's replay limit were skipped` and `; the hub's log was reset at <time>` when they happened. |

The counts are per process. Each change of state is logged once, as `dsh-superagent-signal: <state>: <detail>`.

## Troubleshooting

- **`Waiting for the deployment check`.** Finish dsh-superagent's deployment setup. The loops start again when the plugin restarts.
- **`Off`.** Enable the Source (`managed.sources.signal.enabled`, or the panel).
- **`Set the hub URL, token file and group id`.** Set all three. Check that `groupId` is the internal id (base64 of 32 bytes) or `group.<base64>` of it.
- **`This dsh-superagent version lacks …`.** Upgrade dsh-superagent to 0.3.0 or later.
- **`The hub refused the token (401)`.** The file at `tokenFile` does not hold the hub's `tokenDir/dsh` token. Mount the same value; the Source rereads the file on every request and retries every 5 seconds.
- **`<n> failed polls in a row; last: …`.** The hub is unreachable or failing. `the token file cannot be read` or `the token file holds fewer than 32 characters` point at `tokenFile`; a status in parentheses comes from the hub (see [Signal hub](docs/signal-hub.md)). Any other error shows only its name, such as `TypeError`, since its message may quote what was written. The Source retries every 5 seconds.
- **`… older than the hub's replay limit were skipped`.** dsh was away longer than the hub consumer's `maxReplayAge`. Set it to `14d`.
- **`… the hub's log was reset at …`.** The hub's database was wiped. The Source read on from its oldest message.
- **A quote went to the orchestrator as a new request.** The quoted message is older than 14 days, or it is a health notice. Write a new message, or quote a newer one.
- **A message never arrived.** Check the hub's `/healthz`: `missed.dsh` counts messages dsh skipped as too old, `unclaimed` counts messages no consumer claimed. An unclaimed group message means the hub's `dsh` consumer does not list the group: list it there, in either form. Check also that the sender is on the Policy's `allowed` list (the `from people not on the list` count).
- **The same reply posted twice.** dsh restarted between the hub's send and the Source recording it. The retry sends again.
- **Replies stay pending.** dsh-superagent's `reply` health entry shows the hub's error, such as `recipient not allowed` (403) when the hub's `dsh` consumer does not list `groupId`.

## Development

After cloning, run `mise install` and `lefthook install` once to get the pinned tools and the pre-commit and pre-push hooks.
mise takes Node from `.node-version`; run `corepack enable` once so pnpm comes from `packageManager` in `package.json`.

```sh
pnpm install
pnpm check
```

| Script | Runs |
| --- | --- |
| `pnpm build` | `tsdown`: bundles `src/index.ts` into `lib/` as ESM with type declarations. |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | `vitest run` over `tests/**/*.spec.ts` |
| `pnpm check` | Typecheck, test and build, in that order. |

Tests use a local fake hub. They never call a real one.

Pushing a tag `vX.Y.Z` equal to `v` plus the `version` in `package.json` runs `pnpm check` and attaches `dsh-superagent-signal-X.Y.Z.tgz` to the GitHub release for that tag.
It also pushes `ghcr.io/lkshrk/dsh-superagent-signal:X.Y.Z`, a `scratch` image for linux/amd64 and linux/arm64 that holds only that tarball at `/`, for mounting as a Kubernetes image volume; the release notes give its digest.

## License

MIT. See [LICENSE](LICENSE).
