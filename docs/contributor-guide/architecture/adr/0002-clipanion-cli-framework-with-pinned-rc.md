# ADR-0002: Clipanion as the CLI Framework, RC Pin Accepted

**Status:** Accepted

## Context

The reference branch already implements all ~42 CLI commands with
[Clipanion](https://github.com/arcanis/clipanion) (class-based commands,
`typanion` for typed option validation), after an earlier, discarded
factory-based approach (visible as several "factory-to-class migration" fix
commits in that branch's history). Because ports & adapters isolates the CLI
framework behind `app` (ADR-0001), the cost of the framework choice being
imperfect is low: `app` has zero knowledge of Clipanion, so a future swap
would be confined to `packages/cli`. Alternatives considered: Commander.js
(largest ecosystem, would mean rewriting all commands for no architectural
benefit given the isolation), oclif (batteries-included but more opinionated
than needed, would compete with our own ports & adapters), yargs (mature,
more verbose typings than Clipanion+typanion).

The main concrete risk is not the framework choice itself but that
`packages/cli/package.json` pins a **release candidate**,
`clipanion@^4.0.0-rc.4`, not a stable release.

## Decision

Keep Clipanion. Accept the RC dependency as-is rather than blocking on a
stable 4.x release, on the condition that the version is **pinned exactly**
(no `^` range) so an unreviewed transitive upgrade can't silently change CLI
behavior. Commands must stay thin (business logic in `app`, not in the
command class) so this decision's blast radius, if reversed later, stays
confined to `packages/cli`.

## Consequences

- **Positive:** no framework-migration churn repeated from the reference
  branch; CLI development in Phase 5 starts immediately instead of
  re-litigating the framework choice.
- **Negative:** shipping on a pre-release dependency carries some risk
  (unannounced breaking changes between RC and stable). Mitigated by the
  exact pin and by the framework being isolated behind `app`.
