# Prometheus metrics

With `BAKERY_METRICS=1`, Bakery serves Prometheus metrics on `GET /metrics` for a scraper you run. Unlike [usage telemetry](telemetry.md), Bakery sends nothing anywhere.

These metrics carry repository paths and model names. Anyone who can reach Bakery's address can read them, the same as the rest of its API.

## Turning it on

1. Start the server with `BAKERY_METRICS=1`. Without it, `/metrics` answers 404.
2. Point a Prometheus scrape job at Bakery's address, for example:

```yaml
scrape_configs:
  - job_name: bakery
    scrape_interval: 30s
    static_configs:
      - targets: [127.0.0.1:4317]
```

If Bakery binds to another address with `BAKERY_HOST`, scrape that address. Its host must be `127.0.0.1`, `localhost` or listed in `BAKERY_ALLOWED_HOSTS`.

## How it is counted

Each scrape reads the runs, agent reviews and cards in Bakery's database, so the totals survive restarts. A run counts once it finishes, with its cost, tokens and duration.

Sentinel jobs are left out, as on the Statistics page. Deleting a card removes its runs from the totals, which Prometheus reads as a counter reset.

## Every metric

Labels: `repo` is the board's repository path. `agent` is the run's models as Bakery records them, comma-separated when a run used more than one, or `unknown`.

| Metric | Type | Labels | Value |
| --- | --- | --- | --- |
| `bakery_info` | gauge | `version` | Always 1 |
| `bakery_runs_total` | counter | `repo`, `agent`, `status`, `started_by` | Finished runs. `status` is `review`, `failed` or `interrupted`; `started_by` is `manual` or `auto` |
| `bakery_run_duration_seconds` | histogram | `repo`, `agent`, `status` | Wall time of finished runs. Buckets at 1, 2, 5, 10, 15, 30 and 60 minutes, then 2 and 4 hours |
| `bakery_run_cost_dollars_total` | counter | `repo`, `agent` | Model spend of finished runs |
| `bakery_run_tokens_total` | counter | `repo`, `agent`, `type` | Tokens, with `type` one of `input`, `output`, `cache_read` or `cache_write` |
| `bakery_build_cache_tasks_total` | counter | `repo` | Turbo tasks in finished runs |
| `bakery_build_cache_hits_total` | counter | `repo` | Turbo tasks served from cache |
| `bakery_build_cache_saved_seconds_total` | counter | `repo` | Build time the Turbo cache saved |
| `bakery_agent_reviews_total` | counter | `repo`, `state` | Finished agent reviews, by outcome |
| `bakery_agent_review_cost_dollars_total` | counter | `repo` | Model spend of finished agent reviews |
| `bakery_card_review_rounds_total` | counter | `repo` | Times you requested changes on a card's run |
| `bakery_card_ci_reworks_total` | counter | `repo` | Times a card went back to its agent to fix CI |
| `bakery_cards` | gauge | `repo`, `status` | Cards per lane |
| `bakery_active_runs` | gauge | none | Agent runs going now |
| `bakery_active_agent_reviews` | gauge | none | Agent reviews going now |
| `bakery_active_pull_request_drafts` | gauge | none | Pull request drafts going now |
| `bakery_event_loop_delay_seconds` | gauge | `stat` | How late the server's event loop ran since the previous scrape, with `stat` one of `p50`, `p99` or `max`. See below |

## Event-loop delay

`bakery_event_loop_delay_seconds` comes from Node's `perf_hooks.monitorEventLoopDelay`, sampled every 20 ms, with the 20 ms interval itself taken off so an idle server reads close to 0. Anything that holds the server's single thread (a synchronous Git call, a slow query) shows up as delay, and every request waits that long, `/api/status` included. Each scrape reads the delay since the previous scrape and starts a new window, so scrape from one Prometheus only: a second scraper splits the windows between them. Before the first scrape the window starts when the server does.

A healthy server keeps `p99` in the low milliseconds. A `max` of seconds means something blocked the loop; the server log around that time usually names it.

## Example queries

```promql
# Run spend per repository over the last day
sum by (repo) (increase(bakery_run_cost_dollars_total[1d]))

# Failure rate per model over the last week
sum by (agent) (increase(bakery_runs_total{status="failed"}[7d])) / sum by (agent) (increase(bakery_runs_total[7d]))

# p95 run time per repository
histogram_quantile(0.95, sum by (repo, le) (rate(bakery_run_duration_seconds_bucket[1d])))

# Worst event-loop stall over the last hour
max_over_time(bakery_event_loop_delay_seconds{stat="max"}[1h])
```
