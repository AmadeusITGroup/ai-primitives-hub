/**
 * Domain layer — known gaps of the primitive diagnostics, as data.
 *
 * Each entry declares a failure the product has today (study register
 * G01–G21) so the default run on `main` reports `known-gap` instead of
 * `fail`. The classifier absorbs a failing check only when the invariant,
 * the selectors and the exact `observed` value all match, so a known gap
 * never masks a different failure mode.
 *
 * A PR that fixes a gap deletes its entry (and, where the fix changes the
 * contract, the matching matrix/placement/expected-id data). The doctor
 * then enforces the fix: an entry that matches executed checks but absorbs
 * none is reported as unused.
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
  /** Unique, stable key, e.g. 'G15/I2/prompt'. */
  key: string;
  /** Study register id, G01–G21. */
  id: `G${string}`;
  invariant: InvariantId;
  /** Absent selector = all. A selector on a dimension the subject lacks never matches (bundle subjects have no target/scope). */
  match: { kinds?: PrimitiveKind[]; targets?: TargetType[]; scopes?: DiagnosticScope[] };
  /** Must deep-equal the check's `observed` (arrays compared sorted). */
  observed: JsonValue;
  summary: string;
}

const REJECTED: JsonValue = { status: 'rejected', errorCode: 'BUNDLE.UNSUPPORTED_CONTENT' };

const g15 = (kind: PrimitiveKind, id: string): KnownGap => ({
  key: `G15/I2/${kind}`,
  id: 'G15',
  invariant: 'I2',
  match: { kinds: [kind] },
  observed: { id, kind, occurrences: 1 },
  summary: `${kind} manifest id is "${id}" instead of the expected id`
});

/** Seed known gaps on `be1d161` (requirements Appendix B). */
export const PRIMITIVE_KNOWN_GAPS: readonly KnownGap[] = [
  {
    key: 'G05/I4/mcp-server',
    id: 'G05',
    invariant: 'I4',
    match: { kinds: ['mcp-server'] },
    observed: REJECTED,
    summary: 'mcp-server items are rejected by every target'
  },
  {
    key: 'G08/I4/hook@kiro',
    id: 'G08',
    invariant: 'I4',
    match: { kinds: ['hook'], targets: ['kiro'] },
    observed: REJECTED,
    summary: 'kiro rejects hook items (kiro-cli accepts them)'
  },
  {
    key: 'G17/I4/chat-mode@copilot-cli',
    id: 'G17',
    invariant: 'I4',
    match: { kinds: ['chat-mode'], targets: ['copilot-cli'] },
    observed: REJECTED,
    summary: 'copilot-cli rejects chat-mode items'
  },
  {
    key: 'G18/I8/copilot-cli@repository',
    id: 'G18',
    invariant: 'I8',
    match: { targets: ['copilot-cli'], scopes: ['repository'] },
    observed: { effectiveScope: 'user' },
    summary: 'target add rewrites copilot-cli repository scope to user'
  },
  g15('prompt', 'hello-world.prompt'),
  g15('instruction', 'code-style.instructions'),
  g15('chat-mode', 'review.chatmode'),
  g15('agent', 'security.agent'),
  g15('hook', 'pre-commit.hook'),
  g15('mcp-server', 'github.mcp'),
  g15('spec', 'requirements'),
  {
    key: 'G13/I1/power',
    id: 'G13',
    invariant: 'I1',
    match: { kinds: ['power'] },
    observed: { missingArchivePaths: ['powers/stripe/steering/payments.md'] },
    summary: 'bundle build drops the power directory unit down to POWER.md'
  },
  {
    key: 'G13/I2/power',
    id: 'G13',
    invariant: 'I2',
    match: { kinds: ['power'] },
    observed: { id: 'POWER', kind: 'power', occurrences: 1 },
    summary: 'power manifest id is the file stem "POWER" instead of the directory name'
  }
];
