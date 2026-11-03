# Security scan action

Use this composite action to scan changed Markdown AI artifacts and Claude settings files in pull requests.

```yaml
permissions:
  contents: read
  pull-requests: write # Only required when comment-on-pr is true

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
  - uses: AmadeusITGroup/ai-primitives-hub/github-actions/security-scan@<commit-sha>
    with:
      cli-version: '<scanner-enabled-version>'
      fail-on: HIGH
      comment-on-pr: 'true'
```

Pin the action to a full commit SHA. The action runs with `--ci --ignore-trust none`, uploads JSON and Markdown reports, and fails according to `fail-on`.

Set `cli-version` to an exact published release that includes `security scan`.
Existing releases predating this feature cannot run the action. The action
does not install a development build from the checked-out repository.
Use a full checkout (`fetch-depth: 0`); unavailable comparison commits fail
the workflow rather than being treated as an empty change set.
