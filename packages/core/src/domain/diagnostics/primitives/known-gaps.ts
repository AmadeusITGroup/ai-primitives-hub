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
  /** Absent selector = all. A selector on a dimension the subject lacks never matches (bundle subjects have no target/scope). */
  match: { kinds?: PrimitiveKind[]; targets?: TargetType[]; scopes?: DiagnosticScope[] };
  /** Must deep-equal the check's `observed` (arrays compared sorted). */
  observed: JsonValue;
  summary: string;
}

const REJECTED: JsonValue = { status: 'rejected', errorCode: 'BUNDLE.UNSUPPORTED_CONTENT' };

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
 * #526 places them through the `agents/` route.
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
    summary: 'kiro rejects hook items (kiro-cli accepts them)'
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
  }
];
