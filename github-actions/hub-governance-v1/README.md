# Provider governance — version 1

This directory and [the reusable workflow](../../.github/workflows/hub-governance-v1.yml) are **provider-owned**. Consumer repositories keep their Hub configuration, optional policy, invocation workflow, and merge ruleset. They do not copy installation scripts, validators, Markdown formatting, or comment replacement.

This is an additive implementation: the existing `ai-primitives-hub` executable, collection action, and validation behavior remain unchanged. The governance entry point is shipped as `bin/ai-primitives-hub-governance-v1.js` inside the CLI package. No consumer migration or release has been performed by this change.

## Release prerequisite

The currently referenced CLI `0.1.0` release does **not** contain this new launcher. Do not point a production consumer at this branch or use `latest`. First merge and release the provider changes and all affected shared packages through the existing package release process. Verify the published CLI includes its versioned launcher, compiled governance modules, and bundled policy schema.

Record two release values:

- `PROVIDER_COMMIT_SHA`: the immutable provider commit containing the reusable workflow and action. Use the same SHA in the workflow's `uses` reference and `provider-ref` input.
- `CLI_RELEASE_VERSION`: the exact tested npm release containing the versioned launcher and compatible shared dependencies.

The examples below use placeholders, not published release identifiers. Replace them before use. Upstream [#410](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/410) is an open feature issue; this version does not claim to finish its entire rule roadmap.

## Reusable workflow: primary consumer contract

Add this to the **consumer** repository, such as `genai.prompt-registry-config`:

```yaml
name: Hub governance
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]
    paths:
      - hub-config.yml
      - hub-governance.yml
      - .github/workflows/validate-hub.yml

# The caller must permit the reusable reporting job to request write access.
# The provider's validation job itself has contents: read only.
permissions:
  contents: read
  pull-requests: write

jobs:
  governance:
    uses: AmadeusITGroup/ai-primitives-hub/.github/workflows/hub-governance-v1.yml@PROVIDER_COMMIT_SHA
    with:
      provider-ref: PROVIDER_COMMIT_SHA
      cli-version: CLI_RELEASE_VERSION
      subject: hub
      config-path: hub-config.yml
      # Omit policy-path if no committed policy is needed.
      # policy-path: hub-governance.yml
      post-comment: true
      # runner: your-approved-ephemeral-runner-label
```

Do not use PR-level path filters for a required merge check: an unrelated PR can otherwise wait indefinitely for a skipped workflow. This example runs the inexpensive offline gate on every PR and limits push triggers instead.

Configure the resulting **Governance gate** job as required in the consumer's branch protection/ruleset. Confirm the exact check name after the first run; GitHub may include the caller job's name. Requiring only the intermediate validation job would bypass the final verdict check.

### Inputs

| Input | Default | Contract |
| --- | --- | --- |
| `provider-ref` | Required | Full 40-character provider commit SHA matching `uses`. |
| `cli-version` | Required | Exact npm semver release; not a tag, range, branch, or `latest`. |
| `subject` | `hub` | `hub`, `collection`, or `skill`. |
| `config-path` | `hub-config.yml` | Hub file relative to the consumer root. |
| `policy-path` | Empty | Optional policy file. An explicitly missing/invalid file fails the gate. |
| `min-score` | Empty | Optional score floor from 0 to 100; overrides policy `minScore`. |
| `collection-file` | Empty | One selected collection, or all discovered collections when omitted. |
| `skills-dir` | `skills` | Directory containing skill folders. |
| `runner` | `ubuntu-latest` | Consumer-approved Linux/ephemeral runner label. |
| `post-comment` | `false` | Enable bot comment replacement for same-repository PRs only. |

Selecting a single collection checks uniqueness only within that selected set. Omit `collection-file` for a repository-wide uniqueness gate.

### Outputs and reports

- `verdict`: `pass` or `fail` when the action could prepare and publish results.
- `score`: advisory 0–100 score; empty on provider setup/execution failure.
- `exit-code`: zero only when validation **and** report generation succeeded.
- A provider-generated job summary.
- A `governance-v1-SUBJECT` artifact containing the Markdown report and, when produced, CLI JSON output.
- An optional bot-owned PR comment, updated by a stable subject-specific marker.

Invalid workflow/action inputs or checkout failures may prevent output creation. A missing exit code is a failure, never a pass. The final gate also fails if report publishing was requested and the reporting job fails.

The report is produced before the final gate enforces failures. Dependency installation may use the npm registry; **validation itself never contacts source repositories**. This is not an air-gapped installation guarantee.

## Permissions and fork safety

- Validation is in a separate `contents: read` job; no source secrets are declared or inherited.
- The comment job alone requests `pull-requests: write` and checks out only the immutable provider code, never consumer/fork scripts.
- A reusable workflow cannot grant permissions beyond its caller. The caller must allow `pull-requests: write` because that permission is declared on the reporting job, even though the job may be skipped. Use the composite action below for a strictly read-only workflow.
- Fork PRs get offline validation and a summary, but no comment-writing job or source credentials.
- Installation uses an isolated temporary prefix, with npm lifecycle scripts disabled and outside the consumer working directory.
- The CLI subprocess receives no GitHub token, source credentials, `NODE_OPTIONS`, or `NODE_PATH` from the action environment.
- Comment replacement uses paginated results and only updates `github-actions[bot]` comments with the exact marker. It re-reads the PR head before posting to avoid stale reports.
- Use only approved ephemeral runners for untrusted PR input. This provider does not configure an organization's runner policy.
- Do not run this consumer checkout workflow from `pull_request_target`, and do not add `secrets: inherit`.

## Composite action: read-only consumer jobs

The composite action can be pinned directly when a repository needs to compose validation with existing checks. It creates a summary but does not post PR comments, and fails after reporting by default.

```yaml
permissions:
  contents: read

jobs:
  collections:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: '24'
      - uses: AmadeusITGroup/ai-primitives-hub/github-actions/hub-governance-v1@PROVIDER_COMMIT_SHA
        with:
          cli-version: CLI_RELEASE_VERSION
          subject: collection
```

The composite uses the same validation/policy inputs except `provider-ref`, `runner`, and `post-comment`. It also accepts `working-directory` (consumer root by default) and `fail-on-error` (`true` by default). Set the latter to `false` only if your caller explicitly fails on a nonzero or missing `exit-code` after reporting.

## Optional committed policy

```yaml
minScore: 90
rules:
  COL003:
    severity: warning
    reason: Transitional author metadata migration
  COL006:
    enabled: false
    reason: README completeness is tracked separately
```

Unknown rule IDs, unknown policy properties, malformed YAML, and attempts to disable/downgrade mandatory rules fail with `CFG001`. Every configured disable/severity override is included in JSON and Markdown, even if no finding used it.

The score starts at 100, loses 10 per verified error and 3 per verified warning, and never goes below zero. Unverified findings carry zero weight. The score is advisory unless `minScore`/`--min-score` is set. Errors always fail, regardless of score threshold.

### Offline rule catalogue

| Rule | Default severity | Mandatory | Coverage |
| --- | --- | --- | --- |
| `HUB001` | Error | Yes | Existing Hub YAML parser, bundled schema, required fields, source/profile references, traversal safety, source-type configuration and GitHub bundle prefixes. |
| `HUB002` | Warning | No | Existing Hub validator advisories. |
| `COL001` | Error | Yes | Existing aggregate checks for duplicate collection IDs and names in the validated set. |
| `COL003` | Error | No | Non-empty collection author. |
| `COL005` | Error | Yes | Existing collection structure and referenced-file validation; no empty repository success. |
| `COL006` | Warning | No | Existing collection advisories, such as absent README metadata. |
| `SKL001` | Error | Yes | Existing Agent Skills validator; no empty skills-directory success. |
| `SKL002` | Warning | No | Reserved for future skill advisories; current validator emits none. |
| `CFG001` | Error | Yes | Invalid/unreadable policy or invalid score threshold. |

This version does **not** check published collection releases (`COL002`), hub-wide collection uniqueness (`COL004`), remote source availability, or arbitrary primitive security compliance. `skill` is supported; `primitive validate` for every canonical kind is not implemented. Those need separate reviewed provider changes with proper domain ports and authentication. Existing hub deep-validation CLI behavior is unchanged; the versioned governance entry point deliberately rejects `--check-sources`.

## Provider development and verification

From the provider repository:

```bash
pnpm --filter @ai-primitives-hub/cli... run build
pnpm --filter '@ai-primitives-hub/*' run test
node --test github-actions/hub-governance-v1/test/*.test.cjs
node packages/cli/bin/ai-primitives-hub-governance-v1.js hub validate --config /path/to/hub-config.yml --output json --report-path /tmp/hub-report.md
```

The launcher supports `hub validate`, `collection validate`, and `skill validate`, plus JSON/YAML/NDJSON/text output, `--policy`, `--min-score`, and `--report-path`. It is not yet registered under the existing executable's command surface, preserving existing files during this versioned rollout.

[Provider CI](../../.github/workflows/governance-provider-v1.yml) runs shared validation tests plus execution/reporting/workflow contracts. The focused CLI tests exercise public entry points against actual files; reporting tests mock only the GitHub API boundary. Before release, also smoke-test the **published npm artifact** and the reusable workflow in a test consumer repository. Local tests cannot prove GitHub permissions, organizational runner access, or branch-ruleset configuration.

## Consumer migration checklist

1. Release and verify the provider artifact and immutable workflow SHA.
2. In `genai.prompt-registry-config`, replace PR #126's copied installation/report/comment machinery with a pinned invocation.
3. Run old Python/schema checks alongside provider output temporarily and compare actual results.
4. Remove only duplicated checks after all consumer dependencies have been reviewed. YAML style lint is not supplied by v1; retain it if required by the consumer.
5. Require the final Governance gate in the consumer ruleset and test both failing and passing configuration changes.
6. Verify comment replacement on a subsequent PR update and summary-only behavior for pushes/forks.
7. Migrate collection repositories using `subject: collection`, and skill repositories using `subject: skill`.

## See also

- [Hub governance plan V2](../../HUB_VALIDATION_GOVERNANCE_PLAN_V2.md)
- [Hub configuration reference](../../docs/reference/hub-schema.md)
- [Collection validation guide](../../docs/author-guide/validation.md)
- [Shared package release process](../../docs/contributor-guide/releasing.md)