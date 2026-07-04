# Repository Secret-Safety Policy

## Policy Goal

Repository-scope installation must prevent accidental commit of secrets, local-only credentials, tokens, machine-specific paths, or private runtime artifacts in prompts, instructions, agents, and skills.

## Resource Classes

| Resource | Repository Policy |
|----------|-------------------|
| Prompts | Allowed only when content passes sensitive-content checks and does not embed local-only private values. |
| Instructions | Allowed only when content passes sensitive-content checks and does not embed local-only private values. |
| Agents | Allowed only when metadata and instructions pass sensitive-content checks. |
| Skills | Allowed only when skill files and metadata pass sensitive-content checks. |

## Required Behavior

- Reject unsafe repository-scope writes by default.
- Redact detected secret-like values in diagnostics.
- Offer actionable remediation, such as installing to user scope or removing sensitive content.
- Never print raw secret-like values to logs, CLI stderr, VS Code notifications, or JSON diagnostics.
- Keep local-only repository mode separate from commit-mode lockfile behavior.

## Sensitive Signals

Initial tests should cover at least:

- Token-like key names such as `token`, `api_key`, `password`, `secret`, `client_secret`, and `private_key`.
- PEM private key delimiters.
- Environment variable assignments containing secret-like names.
- Absolute machine-local paths when the target is a shared repository artifact.
- Tool or agent metadata that points to local credential files.

## Future Refinement

This policy should start conservative. False positives can be refined only when tests preserve the no-secret-in-tracked-repository guarantee.