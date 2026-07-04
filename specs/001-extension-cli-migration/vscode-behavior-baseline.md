# VS Code Behavior Baseline

## Production Baseline

The current production baseline is `main` at `faba4a5 fix: test badly isolated test that were changing real mcp.json (#318)`.

## Workflows To Preserve

| Workflow | Current Surface | Baseline Evidence To Capture |
|----------|-----------------|------------------------------|
| Install bundle | `promptRegistry.installBundle`, `BundleInstaller`, scope services | Installed files, stored metadata, notifications, errors |
| Update bundle | `promptRegistry.updateBundle`, update notifications | Updated files, version metadata, no stale state |
| Uninstall bundle | `promptRegistry.uninstallBundle` | Removed files, removed storage entries, lockfile cleanup |
| Repository commit install | `promptRegistry.moveToRepositoryCommit`, repository scope service | `.github` resources and `prompt-registry.lock.json` |
| Repository local-only install | `promptRegistry.moveToRepositoryLocalOnly`, local lockfile behavior | Local-only lockfile and non-committed local state |
| Move back to user | `promptRegistry.moveToUser` | Repository cleanup and user-scope restoration |
| Switch repository mode | `promptRegistry.switchToLocalOnly`, `promptRegistry.switchToCommit` | Lockfile routing and file consistency |
| Hub/profile sync | hub/profile commands and update notifications | Source sync, profile activation/deactivation, update checks |
| WSL and fork user paths | `UserScopeService` path resolution | Correct target path outside the wrong host environment |

## Files And Services To Protect

- `src/services/registry-manager.ts`
- `src/services/bundle-installer.ts`
- `src/services/user-scope-service.ts`
- `src/services/repository-scope-service.ts`
- `src/services/lockfile-manager.ts`
- `src/services/scope-service-factory.ts`
- `src/commands/bundle-commands.ts`
- `src/commands/bundle-scope-commands.ts`
- `package.json` command registrations and menus

## Golden Fixture Baseline

Phase 2 must capture current VS Code user and repository golden fixtures before source-changing target writer work begins.

Required fixture groups:

- User-scope prompts, instructions, agents, and skills.
- Repository-scope prompts, instructions, agents, and skills.
- `prompt-registry.lock.json` commit-mode expectations.
- Local-only repository lockfile expectations.
- Update and uninstall before/after file lists.

## Regression Rule

A shared engine change is acceptable only if this baseline remains true or the spec explicitly records a behavior change and migration path.