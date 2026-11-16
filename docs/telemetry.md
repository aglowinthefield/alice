# Usage telemetry

Bakery can send anonymous usage counts over OpenTelemetry. It is off by default.

## Turning it on

1. Set `BAKERY_TELEMETRY_ENDPOINT` for the server to an OTLP/HTTP endpoint, for example `https://otel.example.com`. Bakery posts to `<endpoint>/v1/metrics` unless the URL already ends in `/v1/metrics`.
2. Turn on **Send anonymous usage counts** in Settings, General.

Without an endpoint the setting is hidden and nothing is sent. With an endpoint but the setting off, nothing is sent either. Turning the setting off applies at once, and counts gathered but not yet sent are dropped.

## How it is sent

- Counts gather in memory and go out in one batch a minute, and once more when the server stops.
- Each send has a 10 second limit. A failed send is dropped, not retried, and never slows or fails a request, a run or a merge.
- The body is an OTLP JSON `ExportMetricsServiceRequest`. Every metric is a delta, monotonic sum.

## Every field sent

Resource attributes, on every batch:

| Field | Value |
| --- | --- |
| `service.name` | `bakery` |
| `service.version` | Bakery's version from `package.json` |
| `os.type` | `linux`, `darwin`, `windows`, `freebsd`, `openbsd` or `other` |
| `bakery.install.id` | A random UUID, created the first time a batch is sent and kept in `telemetry-id` in the data directory. It is not derived from anything on the machine. Delete the file to get a new one. |

Metrics, each with a count and the batch's start and end time:

| Metric | Counts | Attributes |
| --- | --- | --- |
| `bakery.runs.started` | Runs started | none |
| `bakery.runs.finished` | Runs that reached Review | none |
| `bakery.runs.failed` | Runs that failed | none |
| `bakery.runs.stopped` | Runs an operator stopped | none |
| `bakery.merges` | Cards merged into local main | none |
| `bakery.pull_requests.opened` | Pull requests Bakery opened | none |
| `bakery.doctor.failures` | `bakery-cli doctor` checks that failed | `doctor.check`: one of `node`, `git`, `git identity`, `pi`, `pi models`, `worktrunk`, `gh`, `data dir`, `server lock`, `server`, `board`, `bakery-cli`, `bakery server` |
| `bakery.server.errors` | Requests the server answered with an error | `error.type`: the error's class name, such as `Error` or `IntegrationConflictError` |

Board checks in `doctor` are named after the repository path. They are reported as `board`, never with the path.

## Never sent

Code, diffs, prompts, transcripts, card titles or text, error messages, repository paths, branch names, hostnames, usernames, IP addresses Bakery knows of, or model names. The endpoint sees the sender's IP address as any HTTP server does; Bakery adds nothing to it.
