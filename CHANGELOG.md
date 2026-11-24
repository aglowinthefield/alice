# Changelog

## Unreleased

- Auto-review no longer blocks automatic pull requests: a card the agent reviewer hands to a person, or sends back too often, gets a draft pull request with its findings, and a requested rerun at the run limit waits for a free slot.
- Pull-request boards draft the PR and run the repository's commit and pre-push hooks when a run reaches Review, so Approve and open PR opens the dialog with the draft ready and pushes without running the hooks again. A hook that fails at Review goes back to the agent before you review, up to 2 times in a row.
- `scripts/install-desktop.sh` keeps a Mac's Bakery.app built from `origin/main`, rebuilding only when desktop code changed; `--launchd` runs it every hour.
- Sentinels and GitHub pull requests are now optional build features, both off by default. Turn them on with `BAKERY_FEATURE_SENTINELS=1` and `BAKERY_FEATURE_PULL_REQUESTS=1` when building and starting Bakery; stored data is kept, and Approve never merges locally in place of a required pull request. See docs/reference.md.
- `bakery-cli` has a new help screen with a cake, per-command help (`bakery-cli help start`), typo suggestions, and aligned, coloured output on a terminal. Piped output is unchanged. `npm link` also installs it as `bakery`.
- `bakery-cli doctor` names the server it reached, says whether it's local or remote, and prefixes remote board paths with the host. A missing `pi` now reads as not found when a directory on `PATH` is unreadable.
- `bakery-cli doctor` ends with `INFO` rows: the CLI's path, its `BAKERY_*` variables with secrets hidden, and the server's host, features, active runs, agent models, telemetry and Discord webhook state.
