/**
 * Domain layer — known gaps of the primitive diagnostics, as data.
 *
 * Each entry declares a failure the product has today, so the default run
 * on `main` reports `known-gap` instead of `fail`. The classifier absorbs
 * a failing check only when the invariant, the selectors and the exact
 * `observed` value all match, so a known gap never masks a different
 * failure mode.
 *
 * A PR that fixes a gap deletes its entry (and, where the fix changes the
 * contract, the matching matrix/placement/expected-id data). The doctor
 * flags a stale entry: one that matches executed checks but absorbs none
 * is reported under `unusedKnownGaps` (a warning; it does not fail the run).
 * @module domain/diagnostics/primitives/known-gaps
 */
import type {
  TargetType,
} from '../../install/target';
import type {
  PrimitiveKind,
} from '../../primitive/types';
import type {
  DiagnosticInstallMode,
  DiagnosticScope,
  InvariantId,
  JsonValue,
} from './types';

/** One known gap. */
export interface KnownGap {
  /** Unique, stable key: `<id>/<invariant>/<selector>`, e.g. 'manifest-id-file-stem/I2/prompt'. */
  key: string;
  /** Descriptive gap id shared by the entries of one product defect, e.g. 'manifest-id-file-stem'. */
  id: string;
  invariant: InvariantId;
  /**
   * Absent selector = all. A selector on a dimension the subject lacks never matches (bundle subjects have no target/scope).
   * `bundles` lists bundle ids; `kinds` matches a per-item check by its item's kind; `modes` lists case install modes.
   */
  match: { kinds?: PrimitiveKind[]; bundles?: string[]; targets?: TargetType[]; scopes?: DiagnosticScope[]; modes?: DiagnosticInstallMode[] };
  /** Must deep-equal the check's `observed` (arrays compared sorted). */
  observed: JsonValue;
  summary: string;
  /** GitHub issue (in this repository) that tracks the fix, when one exists. */
  issue?: number;
}

const REJECTED: JsonValue = { status: 'rejected', errorCode: 'BUNDLE.UNSUPPORTED_CONTENT' };

/** I4 of a `--skip-unsupported` install that left out content the matrix expects installed. */
const PARTIAL: JsonValue = { status: 'partial', errorCode: null };

/**
 * One `manifest-id-file-stem` entry: `bundle build` derives the manifest
 * id from the item's file stem (keeping a `.prompt`-style type suffix, or
 * `requirements` for a spec) instead of the expected id.
 * @param kind - Item kind.
 * @param id - Manifest id the build produces today.
 * @returns The known gap.
 */
const manifestIdFileStem = (kind: PrimitiveKind, id: string): KnownGap => ({
  key: `manifest-id-file-stem/I2/${kind}`,
  id: 'manifest-id-file-stem',
  invariant: 'I2',
  match: { kinds: [kind] },
  observed: { id, kind, occurrences: 1 },
  summary: `${kind} manifest id is the file stem "${id}" instead of the expected id`
});

/**
 * Known gaps on current `main`. Chat modes on copilot-cli are not listed:
 * #526 places them through the `agents/` route. The default all-or-nothing
 * rejection of a mixed bundle is the expected outcome, not a gap. A check
 * absorbed by several entries lists every matching gap id (e.g. I4 of the
 * portable mix on kiro: `kiro-hook-rejected` and `kiro-plugin-rejected`).
 * The I9 entries absorb an item left out in either install mode: rejected
 * by the default install, or skipped by `install --skip-unsupported`.
 */
export const PRIMITIVE_KNOWN_GAPS: readonly KnownGap[] = [
  {
    key: 'mcp-server-rejected/I4/mcp-server',
    id: 'mcp-server-rejected',
    invariant: 'I4',
    match: { kinds: ['mcp-server'] },
    observed: REJECTED,
    summary: 'mcp-server items are rejected by every target'
  },
  {
    key: 'kiro-hook-rejected/I4/hook@kiro',
    id: 'kiro-hook-rejected',
    invariant: 'I4',
    match: { kinds: ['hook'], targets: ['kiro'] },
    observed: REJECTED,
    summary: 'kiro rejects hook items (kiro-cli accepts them)',
    issue: 549
  },
  {
    key: 'mcp-server-rejected/I9/mcp-server',
    id: 'mcp-server-rejected',
    invariant: 'I9',
    match: { kinds: ['mcp-server'] },
    observed: { rejected: true },
    summary: 'install lists mcp-server items as unsupported content on every target'
  },
  {
    key: 'kiro-hook-rejected/I9/hook@kiro',
    id: 'kiro-hook-rejected',
    invariant: 'I9',
    match: { kinds: ['hook'], targets: ['kiro'] },
    observed: { rejected: true },
    summary: 'kiro lists hook items as unsupported content',
    issue: 549
  },
  {
    key: 'kiro-plugin-rejected/I4/plugin@kiro',
    id: 'kiro-plugin-rejected',
    invariant: 'I4',
    match: { kinds: ['plugin'], targets: ['kiro'] },
    observed: REJECTED,
    summary: 'kiro rejects plugin items: no kiro route for Agent Plugins',
    issue: 549
  },
  {
    key: 'kiro-plugin-rejected/I9/plugin@kiro',
    id: 'kiro-plugin-rejected',
    invariant: 'I9',
    match: { kinds: ['plugin'], targets: ['kiro'] },
    observed: { rejected: true },
    summary: 'kiro lists plugin items as unsupported content',
    issue: 549
  },
  {
    key: 'kiro-hook-rejected/I4/hook@kiro/skip-unsupported',
    id: 'kiro-hook-rejected',
    invariant: 'I4',
    match: { kinds: ['hook'], targets: ['kiro'], modes: ['skip-unsupported'] },
    observed: PARTIAL,
    summary: 'kiro skips hook items with install --skip-unsupported, so a bundle with a hook installs only partially',
    issue: 549
  },
  {
    key: 'kiro-plugin-rejected/I4/plugin@kiro/skip-unsupported',
    id: 'kiro-plugin-rejected',
    invariant: 'I4',
    match: { kinds: ['plugin'], targets: ['kiro'], modes: ['skip-unsupported'] },
    observed: PARTIAL,
    summary: 'kiro skips plugin items with install --skip-unsupported, so a bundle with a plugin installs only partially',
    issue: 549
  },
  {
    key: 'copilot-cli-repository-scope/I8/copilot-cli@repository',
    id: 'copilot-cli-repository-scope',
    invariant: 'I8',
    match: { targets: ['copilot-cli'], scopes: ['repository'] },
    observed: { effectiveScope: 'user' },
    summary: 'target add rewrites copilot-cli repository scope to user'
  },
  manifestIdFileStem('prompt', 'hello-world.prompt'),
  manifestIdFileStem('instruction', 'code-style.instructions'),
  manifestIdFileStem('chat-mode', 'review.chatmode'),
  manifestIdFileStem('agent', 'security.agent'),
  manifestIdFileStem('hook', 'pre-commit.hook'),
  manifestIdFileStem('mcp-server', 'github.mcp'),
  manifestIdFileStem('spec', 'requirements'),
  {
    key: 'power-directory-unit/I1/power',
    id: 'power-directory-unit',
    invariant: 'I1',
    match: { kinds: ['power'] },
    observed: { missingArchivePaths: ['powers/stripe/steering/payments.md'] },
    summary: 'bundle build drops the power directory unit down to POWER.md'
  },
  {
    key: 'power-directory-unit/I2/power',
    id: 'power-directory-unit',
    invariant: 'I2',
    match: { kinds: ['power'] },
    observed: { id: 'POWER', kind: 'power', occurrences: 1 },
    summary: 'power manifest id is the file stem "POWER" instead of the directory name'
  },
  {
    key: 'plugin-skill-projection/I11/plugin',
    id: 'plugin-skill-projection',
    invariant: 'I11',
    match: { kinds: ['plugin'] },
    observed: { unprojected: ['plugin-skill'] },
    summary: 'install copies the plugin directory but does not project its skills into the skills route',
    issue: 549
  },
  {
    key: 'plugin-mcp-projection/I12/plugin',
    id: 'plugin-mcp-projection',
    invariant: 'I12',
    match: { kinds: ['plugin'] },
    observed: { unprojected: ['aph-e2e'] },
    summary: 'install does not merge the plugin MCP servers into a target config file',
    issue: 549
  },
  {
    key: 'plugin-root-unresolved/I14/plugin',
    id: 'plugin-root-unresolved',
    invariant: 'I14',
    match: { kinds: ['plugin'] },
    observed: { unresolved: ['aph-e2e'] },
    summary: 'install leaves ${PLUGIN_ROOT} unresolved in the plugin MCP servers',
    issue: 549
  }
];
