# Default Hubs Configuration

`default-hubs.json` defines the default hubs offered during first-run setup for
both delivery layers: the VS Code extension and the CLI. It is statically
imported by [`default-hubs.ts`](../hub/default-hubs.ts), so TypeScript, webpack,
and esbuild include the same configuration in every distribution format. A
hardcoded copy is retained as a fallback if the imported configuration is
empty.

## How it works

1. `getDefaultHubs()` returns the statically imported configuration when it has
   entries, otherwise it uses the hardcoded fallback.
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
| `recommended` | no | Marks the recommended hub. At most one entry may set it because `getRecommendedHub()` returns the first match. |
| `enabled` | no | Show in the first-run selector (default `true`). |

The `$schema` property validates the configuration against
[`default-hubs-config.schema.json`](../../../core/src/public/schemas/default-hubs-config.schema.json).

## Predicates

`isDefaultHub(reference)` and `isRecommendedDefaultHub(reference)` compare by
`type` and `location` (case-insensitive, ignoring `ref`). Use them instead of
comparing hub names; see `packages/cli/src/commands/init.ts`.
