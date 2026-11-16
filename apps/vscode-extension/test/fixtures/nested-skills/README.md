# Nested skill layout fixture

Source-repository layout reproducing
[AmadeusITGroup/ai-primitives-hub#701](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/701),
modelled on `Amadeus-xDLC/coe.quality-primitives-catalogue`: skills live under a
grouping folder (`skills/generate-test/<skill>/SKILL.md`) instead of directly under `skills/`.

- `nested-automated` — two nested skills plus the flat control skill `skills/flat-control`.
- `nested-manual` — two other nested skills in the same `generate-test` group, so two
  bundles share the group folder.

Every skill must install as `<skills root>/<leaf folder>/SKILL.md`, with only its own files.
`test/run-nested-skills-acceptance.js` builds the bundles with `bundle build` and checks the
CLI and a real VS Code extension host at user and repository scope.
