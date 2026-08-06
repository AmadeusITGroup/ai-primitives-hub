# Default Hubs Configuration

`default-hubs.json` defines the default hubs offered during first-run setup, for
**both** delivery layers (the VS Code extension and the CLI). It is the optional
override for the `HARDCODED_DEFAULT_HUBS` fallback in
[`../src/hub/default-hubs.ts`](../src/hub/default-hubs.ts); keep the two in sync.

## How it works

1. `getDefaultHubs()` loads this file if present, else falls back to the
   hardcoded list. Load failures fall back silently.
2. Each enabled hub is verified for accessibility during first-run
   (`verifyHubAvailability`); an account with no access to a default hub is an
   expected condition, not an error.
3. Verified hubs appear in the selector; the recommended one is starred.

## Properties

| Property | Required | Purpose |
|---|---|---|
| `name` | yes | Display name. Also the identity used by `findDefaultHub`. |
| `description` | yes | Shown in the selector. |
| `icon` | yes | Plain-text icon (emoji) for the CLI. |
| `codicon` | no | VS Code codicon name without `$()`, e.g. `cloud`. |
| `reference` | yes | `{ type: 'github' \| 'local' \| 'url', location, ref?, autoSync? }`. |
| `recommended` | no | Marks the recommended hub. **At most one entry** may set it — `getRecommendedHub()` returns the first match, so several make the result order-dependent. |
| `enabled` | no | Show in the first-run selector (default `true`). |

Validated against
[`default-hubs-config.schema.json`](../../core/src/public/schemas/default-hubs-config.schema.json)
through the `$schema` property.

## Predicates

`isDefaultHub(reference)` and `isRecommendedDefaultHub(reference)` compare by
`type` + `location` (case-insensitive, ignoring `ref`). Use them instead of
comparing hub names — see `packages/cli/src/commands/init.ts`.
