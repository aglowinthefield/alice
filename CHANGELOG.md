# Changelog

## Unreleased

- Sentinels and GitHub pull requests are now optional build features, both off by default. Turn them on with `BAKERY_FEATURE_SENTINELS=1` and `BAKERY_FEATURE_PULL_REQUESTS=1` when building and starting Bakery; stored data is kept, and Approve never merges locally in place of a required pull request. See docs/reference.md.