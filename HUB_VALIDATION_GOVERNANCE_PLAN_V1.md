# Hub Validation Governance Plan — Version 1

## Objective

Establish a single, deterministic GitHub Actions governance gate for every future change to the Hub configuration. The gate must validate YAML quality and the complete Hub configuration without requiring network access or source-repository credentials by default.

## Current state

- Working branch: `feat/hub-validation-governance`
- Sole authoritative workflow: `.github/workflows/validate-hub.yml`
- The old YAML-only workflow has been removed; all its checks are retained in the authoritative workflow.
- Hub configuration: `hub-config.yml`
- Shared validator: `@ai-primitives-hub/cli`, command `ai-primitives-hub hub validate`
- Verified CLI release: `0.1.0`
- Current configuration passes the shared offline validator.

## Governance design

### Required checks

The authoritative workflow must run when any of these files change:

- `hub-config.yml`
- `.config/yamllint`
- The governance workflow itself

It must run for:

- Pull requests: opened, synchronized, reopened, and marked ready for review
- Pushes to branches

The workflow must:

- Use read-only repository permissions.
- Cancel superseded runs for the same branch or pull request.
- Run on the approved Amadeus runner.
- Use a supported, explicit Python version for YAML linting.
- Use an explicit Node.js version for the Hub CLI.
- Pin the Hub CLI version rather than using `latest`.

### Validation sequence

1. Check out the repository.
2. Set up Python 3.12.
3. Install and run `yamllint` using `.config/yamllint`.
4. Run the Python 3.9-compatible `scripts/validate-source-types.py` helper.
5. Run the existing direct JSON Schema validation with `check-jsonschema`.
6. Set up Node.js 22.
7. Install and run the shared Hub validator in offline mode:

   `ai-primitives-hub hub validate --config hub-config.yml --output json`

The shared validator covers:


The versioned workflow deliberately retains the existing checks as independent
steps during rollout. This provides compatibility with the current governance
behavior and makes it clear whether a failure comes from YAML linting, the
source-policy helper, direct schema validation, or the shared validator.

### Phase 1 — Verify the consolidated workflow

Run `.github/workflows/validate-hub.yml` as the only workflow. It includes YAML lint, local source-type validation, direct schema validation, shared Hub validation, and PR reporting.

- Confirm the released CLI works on the repository runner.
- Compare the new shared validation with the existing checks.
- Pull request checks remain parseable and actionable.
- No credentials or network access are required.

### Phase 2 — Compare and then make the shared validator authoritative

After the new workflow has passed in GitHub Actions and the results have been
compared:
- Retain `yamllint`.
- Retain the shared `hub validate` command.
- Decide whether to remove duplicate direct schema validation from the final
   workflow. It may be retained as a defense-in-depth check if the additional
   network dependency is acceptable.
- Decide whether to remove the duplicate local source-type validation step from
   the final workflow. The shared validator should remain the authoritative
   implementation of these policies.
- Avoid maintaining two independent implementations of the same governance rules.

The local Python validator and its tests may then be retired in a separate reviewed cleanup change if no other consumer depends on them:

- `scripts/validate-source-types.py`
- `tests/test_validate_source_types.py`

### Phase 3 — Consolidate workflow naming

Once the shared workflow is proven:

- Select one canonical workflow name and file.
- Retire the duplicate workflow.
- Keep the final workflow focused on Hub governance.
- Update repository documentation to identify the authoritative check.

The transition should be performed in a separate reviewed change so that workflow behavior remains easy to audit.

## Deep validation policy

Do not enable `--check-sources` in the default pull-request gate yet.

Deep validation performs network-dependent operations:

- Source accessibility checks
- Source catalog discovery
- Bundle discovery
- Profile reference resolution
- Version resolution for `latest`
- Pinned-version checks

It can require source-specific credentials and cross-organization token routing. Until that authentication model is ready, deep validation should be used only manually or in a dedicated authenticated workflow with explicitly configured secrets and permissions.

If introduced later, it should be a separate job or workflow with:

- Explicit approval or protected environment controls.
- Minimal token permissions.
- No secrets exposed to untrusted fork pull requests.
- Progress sent to `stderr` when structured JSON output is required.
- Clear distinction between offline governance failures and source availability failures.

## Pull request reporting

The governance workflow publishes the results in two places:

- The GitHub Actions job summary, available from the workflow check.
- One bot-owned pull request comment containing the check table and validator
   output.

The comment contains the marker `<!-- hub-validation-report -->`. On every
subsequent run for the same pull request, the workflow searches for that marker
and updates the existing comment instead of creating another comment. This
keeps the pull request discussion clean while preserving the latest result.

The workflow always builds and publishes the report before the final gate
converts any failed validation into a failed workflow status. On push events,
only the job summary is published because there is no pull request to comment
on.

## Versioning and dependency policy

- Pin `@ai-primitives-hub/cli` to a tested release.
- Upgrade the CLI deliberately in a separate pull request.
- Run the offline validator locally before changing the pinned version.
- Do not use an unreleased branch or `main` as the CI dependency.
- Review CLI release notes for validation behavior changes.

## Local verification commands

Run YAML lint with the configured environment:

`./.venv/bin/yamllint -c .config/yamllint .`

Run the shared validator:

`npx --yes --package=@ai-primitives-hub/cli@0.1.0 ai-primitives-hub hub validate --config hub-config.yml --output json`

Check the Git diff:

`git diff --check`

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Duplicate workflow checks | Keep only the authoritative governance workflow. |
| CLI release behavior changes | Pin the CLI version and upgrade deliberately. |
| Source repositories are unavailable | Keep default validation offline. |
| Secrets leak to fork pull requests | Do not run deep validation with secrets on untrusted PRs. |
| Local validator diverges from shared validator | Make the shared CLI authoritative and retire duplicate checks. |
| Unsupported Python syntax breaks local scripts | Use Python 3.12 in CI and remove redundant Python validation once migrated. |
| Workflow changes do not trigger validation | Include the workflow path and validation configuration paths in the trigger filters. |

## Definition of done

- A pull request modifying `hub-config.yml` receives a required governance check.
- YAML lint and shared Hub validation both pass for the current configuration.
- Offline validation requires no source credentials.
- The CLI version is pinned.
- Only one workflow is authoritative after rollout.
- Duplicate validators are removed or explicitly documented as transitional.
- Deep validation remains opt-in until authentication and token routing are ready.
- The README and repository guidance identify the final authoritative workflow.
