# Hub Validation Governance Plan — Version 2

## Objective

Define the provider/consumer rollout for deterministic Hub validation across the AI Primitives Hub repository and its consumer repositories. Validation must be reusable, versioned, and offline with respect to source-repository access by default.

## Repository responsibilities

### AI Primitives Hub — provider

The AI Primitives Hub repository owns and publishes:

- Validation rules and schemas.
- Shared CLI commands.
- Verdict, score, and report generation.
- The reusable GitHub Actions workflow, including pull-request comment replacement.

The provider repository is the authoritative implementation of validation behavior. Consumer repositories must not reimplement those rules unless a temporary migration check is explicitly documented.

### `genai.prompt-registry-config` — consumer

The consumer repository owns its Hub configuration and invokes the provider's released tooling. Its GitHub workflow:

- Calls a pinned release of the shared workflow and/or CLI.
- Supplies the Hub configuration and an optional governance policy.
- Receives validation results, the job summary, and the pull-request report.
- Uses the resulting check as a required merge gate.

Other collection repositories follow the same consumer model to validate their own collections and primitives.

## Current state

- The consumer repository's PR #126 already calls the shared Hub validation CLI.
- Installation, report formatting, pull-request comment posting, and legacy Python checks are still maintained in the consumer repository.
- The provider's reusable CI is being delivered under PR #410.
- Once the release associated with PR #410 is available, the duplicated consumer-side implementation should be removed in a separate reviewed change.
- `.github/workflows/validate-hub.yml` belongs to the consumer repository; it is not expected to exist in this provider repository.
- The provider repository should validate its own implementation through its provider CI, while consumer repositories should consume released provider artifacts.

## Target architecture

The provider publishes versioned validation capabilities:

1. A shared CLI release.
2. A reusable GitHub Actions workflow.
3. Validation schemas and policy behavior represented by that release.
4. Structured verdict, score, and report output.
5. Pull-request comment replacement implemented by the reusable workflow.

A consumer workflow supplies configuration and policy, then delegates validation and reporting to the pinned provider release. The consumer retains only repository-specific configuration and workflow invocation logic.

## Consumer migration plan

### Phase 1 — Verify the provider release

Before changing the consumer workflow:

- Confirm that PR #410 has been merged and released.
- Confirm the release version and supported invocation contract.
- Verify that the reusable workflow can be called from the consumer repository.
- Verify that configuration and optional governance policy can be passed without source-repository credentials.
- Confirm that the workflow emits a deterministic exit status, job summary, and structured report.
- Confirm that pull-request comments are replaced using a stable marker rather than duplicated.

### Phase 2 — Migrate `genai.prompt-registry-config`

Update the consumer workflow to:

- Pin the released reusable workflow and/or CLI version.
- Pass the repository's Hub configuration.
- Pass the optional governance policy when required.
- Remove consumer-side installation and report-formatting logic that is supplied by the provider.
- Remove consumer-side pull-request comment creation and replacement logic.
- Retain only checks that are genuinely repository-specific.
- Keep the legacy Python checks temporarily if they are needed for comparison during rollout.

The consumer workflow should not use an unreleased provider branch or `latest`.

### Phase 3 — Compare and remove duplicated checks

After the migrated workflow has passed in GitHub Actions:

- Compare the provider verdict with the existing legacy checks.
- Confirm that failures remain actionable and visible in the job summary.
- Confirm that exactly one pull-request report is maintained per pull request.
- Remove duplicated legacy Python validation once no other consumer depends on it.
- Remove obsolete consumer-side installation and reporting steps.
- Document the pinned provider release and the required status check.

Potential legacy files in the consumer repository include:

- `scripts/validate-source-types.py`
- `tests/test_validate_source_types.py`

These files must only be removed after dependency and consumer usage checks.

## Validation policy

The default pull-request gate should validate the complete supplied Hub configuration without requiring access to source repositories or source-specific credentials.

Do not enable deep source validation by default until the authentication model is ready. Deep validation may include:

- Source accessibility checks.
- Source catalog discovery.
- Bundle discovery.
- Profile reference resolution.
- Version resolution for `latest`.
- Pinned-version checks.

If deep validation is introduced, it should be a separate authenticated job or workflow with:

- Explicit approval or protected-environment controls.
- Minimal token permissions.
- No secrets exposed to untrusted fork pull requests.
- Progress written to `stderr` when structured JSON output is required.
- A clear distinction between offline configuration failures and source-availability failures.

## Versioning and dependency policy

- Pin the provider workflow and CLI to tested releases.
- Upgrade provider versions in separate reviewed pull requests.
- Verify the offline validator locally before upgrading.
- Review provider release notes for validation behavior changes.
- Do not use an unreleased branch, mutable tag, or `latest` in consumer CI.
- Keep provider and consumer responsibilities documented so validation rules do not diverge.

## Required consumer workflow behavior

The consumer workflow should:

- Run when the Hub configuration, governance policy, or consumer workflow changes.
- Run for relevant pull-request events and pushes to the selected branches.
- Use the minimum repository permissions required by the reusable workflow.
- Cancel superseded runs for the same branch or pull request.
- Use explicit runtime versions where the reusable workflow requires them.
- Publish the provider-generated job summary and pull-request report.
- Fail the check when the provider returns a failing verdict.

The exact workflow path and trigger filters belong to the consumer repository. They should not be documented as files owned by the provider.

## Required merge protection

The consumer repository must configure its branch protection or repository ruleset so the provider validation check is a required status check. This configuration is separate from publishing the reusable workflow and must be verified after migration.

The provider repository should also require its own provider CI checks, including tests for:

- Validation rules and schemas.
- CLI behavior.
- Verdict, score, and report generation.
- Reusable workflow execution.
- Pull-request comment replacement.

## Definition of done

- PR #126's consumer-side invocation is replaced or upgraded to the released provider workflow/tooling.
- Provider workflow and CLI versions are pinned.
- Configuration and optional governance policy are passed from the consumer.
- Installation, report formatting, and pull-request comment replacement are provided by the provider release.
- Legacy Python checks are removed after comparison and dependency review, or explicitly documented as transitional.
- The default gate requires no source credentials.
- Deep source validation remains opt-in until authentication and token routing are ready.
- The consumer's provider validation check is configured as a required merge gate.
- Provider documentation identifies the reusable workflow contract and release policy.
- Consumer documentation identifies the pinned provider release and invocation contract.
