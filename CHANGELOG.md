# Changelog

## Unreleased

- Unattended review never merges into local main. On a local board an agent-approved card waits for your Approve; pull-request boards still open the PR. The verification command, the merge limit, `bakery-cli board --merge-limit` and `scripts/verify.sh` are gone.
- The agent reviewer runs the repository's checks itself instead of sending a card back for missing proof. Checks only a person can do, such as device runs, screenshots or staging, go to you.
- Browser notifications now use Web Push: turn on **Notify this browser when a card needs you** in Settings and you get one when a card becomes your turn or fails, even with no Bakery tab open. Clicking it opens the card. It replaces the old Review notification, which only fired while a board page was open. Needs HTTPS or localhost.
- **Approve and update PR #N** pushes to the open PR without a confirmation prompt. Approving a merge into local main still asks first.
- `BAKERY_METRICS=1` serves Prometheus metrics on `/metrics`: runs, outcomes, run time, spend and tokens per repository and model, agent reviews, cards per lane and active runs. They're read from the database on each scrape, so totals survive restarts. See docs/metrics.md.
- Pull-request boards draft the PR and run the repository's commit and pre-push hooks when a run reaches Review, so Approve and open PR opens the dialog with the draft ready and pushes without running the hooks again. A hook that fails at Review goes back to the agent before you review, up to 2 times in a row.
- `scripts/install-desktop.sh` keeps a Mac's Bakery.app built from `origin/main`, rebuilding only when desktop code changed; `--launchd` runs it every hour.
- Sentinels and GitHub pull requests are now optional build features, both off by default. Turn them on with `BAKERY_FEATURE_SENTINELS=1` and `BAKERY_FEATURE_PULL_REQUESTS=1` when building and starting Bakery; stored data is kept, and Approve never merges locally in place of a required pull request. See docs/reference.md.
- `bakery-cli` has a new help screen with a cake, per-command help (`bakery-cli help start`), typo suggestions, and aligned, coloured output on a terminal. Piped output is unchanged. `npm link` also installs it as `bakery`.
- `bakery-cli doctor` names the server it reached, says whether it's local or remote, and prefixes remote board paths with the host. A missing `pi` now reads as not found when a directory on `PATH` is unreadable.
- `bakery-cli doctor` ends with `INFO` rows: the CLI's path, its `BAKERY_*` variables with secrets hidden, and the server's host, features, active runs, agent models, telemetry and Discord webhook state.