# Configuration

The Source's config is validated by `SignalConfigSchema` in `src/config.ts`. Unknown keys are rejected. Strings are trimmed.

Set it in the dsh-superagent panel under the Signal Source, or in dsh-superagent's plugin configuration at `managed.sources.signal.config`, with `managed.sources.signal.enabled` to switch it on. The Policy lives at `managed.policy.sources.signal`. Inside dsh-superagent these are `settings.sources.signal` and `settings.policy.sources.signal`.

The plugin needs no environment variables. It needs one mounted file, the hub token, and network access to the hub's API port.

## Keys

### `hubUrl`

| | |
| --- | --- |
| Type | `http(s)://…` without a trailing `/`, or empty |
| Default | `''` |
| Panel | "Hub URL" |

The hub's API base URL, such as `http://signal-hub.tools.svc.cluster.local:8080`. Required.

### `tokenFile`

| | |
| --- | --- |
| Type | Absolute path, or empty |
| Default | `''` |
| Panel | "Hub token file" |

File holding the token of the hub consumer `dsh`: the same value as the hub's `tokenDir/dsh`, at least 32 characters after trimming. The client reads it on every request, so a rotated token takes effect on the next pull. Required. An account field: only the panel and the plugin configuration may change it, not a main-Session tool.

### `groupId`

| | |
| --- | --- |
| Type | Internal id (base64 of 32 bytes), `group.<base64>`, or empty |
| Default | `''` |
| Panel | "Signal group id" |

The one group the Source serves. Stored as given and compared as the internal id, so either form works. Messages from other groups are ignored, and Channels outside it are refused. The hub's `dsh` consumer must list exactly this group, in either form. Required.

### Advanced keys

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `pollWaitSeconds` | integer, 0–60 | `30` | The hub's long-poll `wait`. Intake runs back to back; with `0` it waits 1 second after an empty page. |
| `pollLimit` | integer, 1–500 | `100` | Messages per pull. |
| `notifyTickets` | boolean | `true` | The immediate notice when a ticket needs a person: it asks a question, is blocked or failed. |
| `notifyProgress` | boolean | `false` | The batched start and summary messages about tickets. Off, the Source keeps no batch, drops one stored earlier without posting it, and replays nothing when it is turned on again. |
| `notifyHealth` | boolean | `true` | Notices when another Source or sync entry fails or recovers. |
| `healthGraceSeconds` | integer, 0–3600 | `60` | How long an entry must stay `error` before its failure notice. An error that clears sooner is never announced. |
| `attachmentMaxBytes` | integer, 0–26214400 | `10485760` | Inbound attachments larger than this are listed as `(too large to read)` and never fetched. Image reading also respects dsh's own image limits. |
| `batchSettleSeconds` | integer, 0–3600 | `120` | Only with `notifyProgress`. The start message waits until no other ticket started for this long, but at most five times this long after its first ticket started; the summary waits until every ticket of the batch ended and none ended for this long. `0` posts on the next notice round. |
| `batchMaxHours` | integer, 1–48 | `4` | Only with `notifyProgress`. While tickets still run, an ended ticket waits at most this long for its summary: a partial summary lists the ended ones and those still running, and the batch goes on. |

While `hubUrl`, `tokenFile` or `groupId` is empty, or `groupId` is not a valid group id, the Source is `paused` with `Set the hub URL, token file and group id`, and takes nothing in.

## Policy

```yaml
allowed:
  - id: <Signal ACI UUID, lower case, or E.164 number>
    name: <optional label>
```

Only people on `allowed` originate work. A message is taken in when dsh-superagent's `admits` accepts its sender's UUID or, failing that, its number. List the UUID: a sender who hides their number from the group is known only by it. The Source has one admission row, `chat`, and admits nobody who is not listed, addressed or not.

## Example: h-cloud

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
```

On the hub's side, the `dsh` consumer:

```yaml
consumers:
  - name: dsh
    groups:
      - group.<base64 of the internal id>
    maxReplayAge: 14d
```

`maxReplayAge: 14d` matches the hub's retention, so a long dsh outage loses nothing the hub still holds.

## Install

From the image, as a Kubernetes image volume. Each release pushes `ghcr.io/lkshrk/dsh-superagent-signal:<version>`, a `scratch` image for linux/amd64 and linux/arm64 holding only `/dsh-superagent-signal-<version>.tgz`. Pin the digest from the release notes' last line:

```text
Image: ghcr.io/lkshrk/dsh-superagent-signal:<version>@sha256:…
```

```yaml
volumes:
  - name: dsh-superagent-signal
    image:
      reference: ghcr.io/lkshrk/dsh-superagent-signal:<version>@sha256:<digest>
      pullPolicy: IfNotPresent
```

Mount it read-only, for example at `/opt/dsh-plugins/dsh-superagent-signal`, and install the tarball from there:

```sh
dsh plugin --profile <profile> add "file:/opt/dsh-plugins/dsh-superagent-signal/dsh-superagent-signal-<version>.tgz"
```

From the release tarball: download `dsh-superagent-signal-<version>.tgz` from the GitHub release and install it the same way.

Then enable the plugin in the profile's `cordis.patch.yml`; its bundle layer inserts it disabled:

```yaml
- id: dsh-superagent-signal
  disabled: false
```

The plugin requires dsh-superagent `>= 0.3.0`.
