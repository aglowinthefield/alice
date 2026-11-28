# Prometheus metrics

With `ALICE_METRICS=1`, Alice serves Prometheus metrics on `GET /metrics` for a scraper you run. Unlike [usage telemetry](telemetry.md), Alice sends nothing anywhere.

These metrics carry repository paths and model names. Anyone who can reach Alice's address can read them, the same as the rest of its API.

## Turning it on

1. Start the server with `ALICE_METRICS=1`. Without it, `/metrics` answers 404.
2. Point a Prometheus scrape job at Alice's address, for example:

```yaml
scrape_configs:
  - job_name: alice
    scrape_interval: 30s
    static_configs:
      - targets: [127.0.0.1:4317]
```

If Alice binds to another address with `ALICE_HOST`, scrape that address. Its host must be `127.0.0.1`, `localhost` or listed in `ALICE_ALLOWED_HOSTS`.

## How it is counted

Each scrape reads the runs, agent reviews and cards in Alice's database, so the totals survive restarts. A run counts once it finishes, with its cost, tokens and duration.

Deleting a card removes its runs from the totals, which Prometheus reads as a counter reset.

## Every metric

Labels: `repo` is the board's repository path. `agent` is the run's models as Alice records them, comma-separated when a run used more than one, or `unknown`.

| Metric | Type | Labels | Value |
| --- | --- | --- | --- |
| `alice_info` | gauge | `version` | Always 1 |
| `alice_runs_total` | counter | `repo`, `agent`, `status`, `started_by` | Finished runs. `status` is `review`, `failed` or `interrupted`; `started_by` is `manual` or `auto` |
| `alice_run_duration_seconds` | histogram | `repo`, `agent`, `status` | Wall time of finished runs. Buckets at 1, 2, 5, 10, 15, 30 and 60 minutes, then 2 and 4 hours |
| `alice_run_cost_dollars_total` | counter | `repo`, `agent` | Model spend of finished runs |
| `alice_run_tokens_total` | counter | `repo`, `agent`, `type` | Tokens, with `type` one of `input`, `output`, `cache_read` or `cache_write` |
| `alice_build_cache_tasks_total` | counter | `repo` | Turbo tasks in finished runs |
| `alice_build_cache_hits_total` | counter | `repo` | Turbo tasks served from cache |
| `alice_build_cache_saved_seconds_total` | counter | `repo` | Build time the Turbo cache saved |
| `alice_agent_reviews_total` | counter | `repo`, `state` | Finished agent reviews, by outcome |
| `alice_agent_review_cost_dollars_total` | counter | `repo` | Model spend of finished agent reviews |
| `alice_card_review_rounds_total` | counter | `repo` | Times you requested changes on a card's run |
| `alice_card_ci_reworks_total` | counter | `repo` | Times a card went back to its agent to fix CI |
| `alice_cards` | gauge | `repo`, `status` | Cards per lane |
| `alice_active_runs` | gauge | none | Agent runs going now |
| `alice_active_agent_reviews` | gauge | none | Agent reviews going now |
| `alice_active_pull_request_drafts` | gauge | none | Pull request drafts going now |
| `alice_event_loop_delay_seconds` | gauge | `stat` | How late the server's event loop ran since the previous scrape, with `stat` one of `p50`, `p99` or `max`. See below |

## Event-loop delay

`alice_event_loop_delay_seconds` comes from Node's `perf_hooks.monitorEventLoopDelay`, sampled every 20 ms, with the 20 ms interval itself taken off so an idle server reads close to 0. Anything that holds the server's single thread (a synchronous Git call, a slow query) shows up as delay, and every request waits that long, `/api/status` included. Each scrape reads the delay since the previous scrape and starts a new window, so scrape from one Prometheus only: a second scraper splits the windows between them. Before the first scrape the window starts when the server does.

A healthy server keeps `p99` in the low milliseconds. A `max` of seconds means something blocked the loop; the server log around that time usually names it.

## Example queries

```promql
# Run spend per repository over the last day
sum by (repo) (increase(alice_run_cost_dollars_total[1d]))

# Failure rate per model over the last week
sum by (agent) (increase(alice_runs_total{status="failed"}[7d])) / sum by (agent) (increase(alice_runs_total[7d]))

# p95 run time per repository
histogram_quantile(0.95, sum by (repo, le) (rate(alice_run_duration_seconds_bucket[1d])))

# Worst event-loop stall over the last hour
max_over_time(alice_event_loop_delay_seconds{stat="max"}[1h])
```
