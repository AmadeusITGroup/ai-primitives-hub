# Quickstart: Extension and CLI Migration

## Current Setup

```bash
git status --short --branch
specify version
```

Expected branch: `feat/extension-cli-migration`.

## Baseline Validation Before Source Migration

Run these before the first source-code port so the migration has a clean baseline from `main`:

```bash
npm install
npm run compile
npm run lint
npm run test:unit
```

Run broader validation when a slice touches integration flows, packaging, or VS Code activation:

```bash
npm run test:integration
npm run test:all
npm run package:vsix
```

## Spec Kit Workflow

The active feature directory is pinned in `.specify/feature.json`:

```text
specs/001-extension-cli-migration
```

Use the generated Copilot prompts or agents for later stages:

```text
/speckit.clarify
/speckit.plan
/speckit.checklist
/speckit.tasks
/speckit.analyze
```

## Cherry-Pick Workflow

For each cluster from `feat/cli-backup`:

1. Read the cluster in `plan.md`.
2. Inspect each commit with `git show --stat <commit>` and `git show --name-only <commit>`.
3. Decide whether to cherry-pick, manually port, or defer.
4. Apply only one cluster at a time.
5. Run the cluster validation command before moving to the next cluster.

Avoid applying `ec15a5d` until the package-manager and monorepo migration slice is explicitly accepted.