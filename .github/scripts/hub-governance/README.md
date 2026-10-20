# Provider governance — version 1

This directory and [the reusable workflow](../../workflows/hub-governance.yml) are **provider-owned**. Consumer repositories keep their Hub configuration, optional policy, invocation workflow, and merge ruleset. They do not copy installation scripts, validators, Markdown formatting, or comment replacement.

Governance extends the existing `ai-primitives-hub hub validate`, `collection validate`, and `skill validate` commands, and adds `primitive validate`. Enable it with `--governance`, `--policy`, `--min-score`, or `--report-path`; plain validation retains its previous behavior and output. The standard CLI is the workflow's only validation entry point: there is no separate governance executable or custom governance action. The workflow owns installation, explicit CLI arguments, publication and gating. The local `run.cjs` helper only isolates the installed CLI's environment, captures its process status/output, and publishes reports; `post-comment.cjs` handles optional comment replacement. No consumer migration or release has been performed by this change.

## Release prerequisite

The currently referenced CLI `0.1.0` release does **not** contain these new validation options. Do not point a production consumer at this branch or use `latest`. First merge and release the provider changes and all affected shared packages through the existing package release process. Verify the published CLI includes the integrated validation commands, compiled governance modules, and bundled policy schema.

Record two release values:

- `PROVIDER_COMMIT_SHA`: the immutable provider commit containing the reusable workflow and its scripts. Use the same SHA in the workflow's `uses` reference and `provider-ref` input.
- `CLI_RELEASE_VERSION`: the exact tested npm release containing integrated governance options and compatible shared dependencies.

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
    uses: AmadeusITGroup/ai-primitives-hub/.github/workflows/hub-governance.yml@PROVIDER_COMMIT_SHA
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
| `check-sources` | `false` | Opt-in Hub release/inventory checks; contacts configured sources. Hub subject only. |
| `check-releases` | `false` | Opt-in collection release checks; contacts GitHub. Collection subject only. |
| `repository` | Empty | GitHub owner/repo or URL for collection release verification. Required to verify publication; selection alone does not enable checks. |
| `runner` | `ubuntu-latest` | Consumer-approved Linux/ephemeral runner label. |
| `post-comment` | `false` | Enable bot comment replacement for same-repository PRs only. |

Selecting a single collection checks uniqueness only within that selected set. Omit `collection-file` for a repository-wide uniqueness gate.

The reusable workflow optionally accepts the explicitly named `source-token` secret. It is forwarded only for a matching requested source check on pushes, dispatches, schedules, or same-repository PRs, never forks, `pull_request_target`, or unrelated events. Use approved protected jobs for private-source verification and a least-privilege source-read token. No secrets are inherited automatically.

### Outputs and reports

- `verdict`: `pass` or `fail` when the workflow could prepare and publish results.
- `score`: advisory 0–100 score; empty on provider setup/execution failure.
- `exit-code`: zero only when validation **and** report generation succeeded.
- A provider-generated job summary.
- A `governance-SUBJECT` artifact containing the Markdown report and, when produced, CLI JSON output.
- An optional bot-owned PR comment, updated by a stable subject-specific marker.

Invalid workflow inputs or checkout failures may prevent output creation. A missing exit code is a failure, never a pass. The final gate also fails if report publishing was requested and the reporting job fails.

The report is produced before the final gate enforces failures. Dependency installation may use the npm registry; validation contacts source repositories only when `check-sources` or `check-releases` is explicitly enabled. This is not an air-gapped installation guarantee.

## Permissions and fork safety

- Validation is in a separate `contents: read` job; the optional named source secret is guarded as described above, never inherited implicitly.
- The comment job alone requests `pull-requests: write` and checks out only the immutable provider code, never consumer/fork scripts.
- A reusable workflow cannot grant permissions beyond its caller. The caller must allow `pull-requests: write` because that permission is declared on the reporting job, even though the job may be skipped. Use standard CLI steps below for a strictly read-only workflow.
- Fork PRs get validation and a summary, but no comment-writing job or source credentials. Requested source checks can access public data anonymously; inaccessible private evidence fails unverified.
- Installation uses an isolated temporary prefix, with npm lifecycle scripts disabled and outside the consumer working directory.
- The CLI subprocess never inherits ambient GitHub tokens, `NODE_OPTIONS`, or `NODE_PATH`. Only a deliberately supplied `source-token` is mapped to `GH_TOKEN`, and only for a matching explicit network check.
- Comment replacement uses paginated results and only updates `github-actions[bot]` comments with the exact marker. It re-reads the PR head before posting to avoid stale reports.
- Use only approved ephemeral runners for untrusted PR input. This provider does not configure an organization's runner policy.
- Do not run this consumer checkout workflow from `pull_request_target`, and do not add `secrets: inherit`.

## Standard CLI: read-only consumer jobs

For validation alongside existing checks, install a compatible exact CLI release and invoke the same standard commands used locally. There is no custom governance action to call. This minimal offline example preserves CLI exit status and a Markdown artifact, but does not provide the reusable workflow's job summary, output contract, credential isolation or bot-comment machinery. Use an approved ephemeral runner and no credentials for untrusted input.

```yaml
name: Standard CLI validation
on: [pull_request, push]

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
      - name: Install an exact CLI release outside the consumer
        working-directory: ${{ runner.temp }}
        env:
          CLI_VERSION: CLI_RELEASE_VERSION
          NPM_CONFIG_USERCONFIG: /dev/null
        run: npm install --prefix "$RUNNER_TEMP/hub-cli" --ignore-scripts --package-lock=false --no-audit --no-fund --registry=https://registry.npmjs.org "@ai-primitives-hub/cli@$CLI_VERSION"
      - name: Validate using the standard CLI
        env:
          AI_PRIMITIVES_HUB_DISABLE_GH_CLI: '1'
          GH_TOKEN: ''
          GITHUB_TOKEN: ''
          NODE_OPTIONS: ''
          NODE_PATH: ''
        run: node "$RUNNER_TEMP/hub-cli/node_modules/@ai-primitives-hub/cli/bin/ai-primitives-hub.js" hub validate --config hub-config.yml --governance --output json --report-path "$RUNNER_TEMP/hub-report.md"
      - name: Preserve the report even when validation fails
        if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: hub-validation-report
          path: ${{ runner.temp }}/hub-report.md
          if-no-files-found: error
```

Replace `hub validate --config hub-config.yml` with `collection validate` or `skill validate --skills-dir skills` for local authoring content. Remote checks remain explicit opt-ins. Do not copy an example that uses the removed custom governance action from historical plans or reports; those documents are retained as snapshots, not current integration guidance.

## Existing collection action

Collection repositories can keep using `github-actions/validate-collections` at a pinned provider commit. Without new inputs it performs the previous validation. Set `governance: 'true'` or supply `policy-path`, `min-score`, or `report-path` to enable shared governance. `collection-file` selects one collection only in governance mode; omit it for repository-wide uniqueness.

Governance mode supplies `verdict`, `score`, and `exit-code` outputs, prints the provider Markdown report, and writes a job summary. Validation or report-write failure fails the step. This bundled action does not install the CLI or post PR comments; use the reusable workflow when centralized artifacts and comment replacement are needed.

Set `check-releases: 'true'` and `repository: owner/repo` for `COL002`. An optional explicit `source-token` supplies source-read access only in this mode; no ambient token or host CLI credential store is used. The caller must not expose this input on untrusted forks. Hub-wide `COL004` uses the Hub CLI/reusable workflow, not this collection-only action.

## Optional governance configuration (`hub-governance.yml`)

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

The CLI discovers `hub-governance.yml` at the repository root; `policy-path`/`--policy` replaces it. PR-scoped hub runs (`base-ref`/`head-ref`) read it from the merge base, so the PR under review cannot relax its own gate. The schema is `packages/core/src/public/schemas/hub-governance.schema.json`.

Configuration problems fail the run and the configuration is ignored for that run: `CFG001` (YAML or schema), `CFG002` (unknown or non-configurable rule id), `CFG003` (floor rule disabled or downgraded), `CFG004` (score outside 0–100). Every configured disable/severity override is included in JSON and Markdown, even if no finding used it.

The score starts at 100, loses 10 per verified error and 3 per verified warning, and never goes below zero. Unverified findings carry zero weight. The score is advisory unless `minScore`/`--min-score` is set. Errors always fail, regardless of score threshold. Offline runs list the network rules they skipped under **Not checked**.

### Rule catalogue

The full, generated list is [docs/author-guide/rule-catalogue.md](../../../docs/author-guide/rule-catalogue.md) (regenerate with `pnpm -C packages/app run generate:rule-catalogue`). Floor rules are `COL001`, `COL002`, `COL005`, `HUB001` and `SKL001`. New primitive rules (`AGT001`, `PRM001`, `INS001`, `MCP001`, `MCP002`) ship as warnings.

`COL002` requires a non-draft, non-prerelease release with a standalone deployment manifest (YAML/JSON) declaring identity/version and a ZIP or TAR.GZ archive. Pagination is exhaustive, repository snapshots are reused within a run, and inaccessible pages/manifests make unmatched queries unverified, not definitively missing. This is existence verification, not full profile-version compliance.

`COL004` compares raw Awesome Copilot definition IDs and canonical GitHub release-manifest IDs across enabled sources, deduplicating versions only within one source. Non-collection source types are excluded. Incomplete inventories produce unverified failures. Requested releases for local-only definitions without GitHub publication context cannot be verified.

Unavailable evidence fails the gate without reducing the score. Both checks are skipped by default; enable collection `--check-releases --repository owner/repo` or Hub `--governance --check-sources`. Existing plain Hub `--check-sources` retains its deep source/profile-version validation. `primitive validate` covers skills, agents, prompts, instructions and MCP servers; other primitive kinds are out of scope.

## Provider development and verification

From the provider repository:

```bash
pnpm --filter @ai-primitives-hub/cli... run build
pnpm --filter '@ai-primitives-hub/*' run test
node --test .github/scripts/hub-governance/test/*.test.cjs
pnpm -C github-actions/validate-collections run build
pnpm -C github-actions/validate-collections run test
node packages/cli/bin/ai-primitives-hub.js hub validate --governance --config /path/to/hub-config.yml --output json --report-path /tmp/hub-report.md
```

The existing executable supports governance on `hub validate`, `collection validate`, and `skill validate`, with JSON/YAML/NDJSON/text output. In governance mode, collection `--markdown-path` remains a compatible report destination; on its own it keeps the legacy Markdown format.

[Provider CI](../../workflows/governance-provider.yml) runs shared validation tests plus execution/reporting/workflow contracts. The execution tests run the workflow's actual shell commands against a fake installed CLI boundary; reporting tests mock only the GitHub API boundary. Before release, also smoke-test the **published npm artifact** and the reusable workflow in a test consumer repository. Local tests cannot prove GitHub permissions, organizational runner access, or branch-ruleset configuration.

## Consumer migration checklist

1. Release and verify the provider artifact and immutable workflow SHA.
2. In `genai.prompt-registry-config`, replace PR #126's copied installation/report/comment machinery with a pinned invocation.
3. Run old Python/schema checks alongside provider output temporarily and compare actual results.
4. Remove only duplicated checks after all consumer dependencies have been reviewed. YAML style lint is not supplied; retain it if required by the consumer.
5. Require the final Governance gate in the consumer ruleset and test both failing and passing configuration changes.
6. Verify comment replacement on a subsequent PR update and summary-only behavior for pushes/forks.
7. Migrate collection repositories using `subject: collection`, and skill repositories using `subject: skill`.

## See also

- [Hub configuration reference](../../../docs/reference/hub-schema.md)
- [Collection validation guide](../../../docs/author-guide/validation.md)
- [Shared package release process](../../../docs/contributor-guide/releasing.md)