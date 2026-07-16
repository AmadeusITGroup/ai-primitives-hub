# ADR-0004: CLI-Only Rebrand — Keep Lockfile and Extension Identity Stable

**Status:** Accepted

## Context

The reference branch forked before the project's rename from "Prompt
Registry" to "AI Primitives Hub" (commit `4ef88f3` on `main`) and is still
100% `prompt-registry`-branded: npm scope, CLI binary name, project config
file (`prompt-registry.yml`), and hidden state directory (`.prompt-registry/`).
None of these CLI-specific artifacts have any real users yet, since the CLI
was never released.

Separately, `main`'s own rename commit deliberately left several
**machine identifiers** unchanged even though the human-facing brand
changed: the extension's `package.json` `name` (`prompt-registry`) and
`publisher`/marketplace ID (`AmadeusITGroup.prompt-registry`, used directly
in code as `EXTENSION_ID`), its command IDs (`promptregistry.*`), and the
repository-scope bundle lockfile filenames
(`prompt-registry.lock.json` / `prompt-registry.local.lock.json`, in
`src/services/lockfile-manager.ts`). These are load-bearing for real,
already-installed users and already-committed lockfiles in downstream
repositories.

## Decision

Rebrand only the artifacts with zero existing users: npm scope
(`@ai-primitives-hub/*`), CLI binary name (`ai-primitives-hub`), project
config file (`ai-primitives-hub.yml`/`.yaml`), and hidden state directory
(`.ai-primitives-hub/`). Do **not** rename the repository-scope lockfile or
the extension's package/marketplace identity — the CLI's future
repository-scope install/uninstall commands must read and write the exact
same `prompt-registry.lock.json` the extension already uses, so a repository
can be worked on interchangeably by either tool (this is also the concrete,
testable proof that ADR-0001's "one shared domain" goal actually holds for
persisted state, not just in-memory code).

## Consequences

- **Positive:** no forced migration for existing extension users or
  already-committed repository lockfiles; the CLI and extension interoperate
  on shared repository state from day one.
- **Positive:** avoids the rename churn the reference branch will eventually
  have to do anyway (it still carries the old "prompt-registry" branding).
- **Negative:** two different naming conventions coexist in the codebase
  (legacy `prompt-registry.*` for pre-existing artifacts, `ai-primitives-hub`
  for new ones) until the lockfile is naturally retired far in the future,
  if ever. Documented here precisely so it isn't mistaken for an oversight.
