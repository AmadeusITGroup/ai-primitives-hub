/**
 * Domain layer — primitive diagnostics support matrix.
 *
 * Which isolated kind each target supports, seeded from the behaviour
 * observed on `be1d161` (requirements Appendix A). A cell the product
 * should support but rejects today is `native` and covered by a known gap
 * (chat-mode on copilot-cli G17, hook on kiro G08, mcp-server everywhere
 * G05). `projected` is reserved for PR-16 and unused here.
 * @module domain/diagnostics/primitives/support-matrix
 */
import {
  TARGET_TYPES,
  type TargetType,
} from '../../install/target';
import type {
  PrimitiveKind,
} from '../../primitive/types';

/** How a target supports a kind. */
export type SupportLevel = 'native' | 'projected' | 'unsupported';

/**
 * Build a matrix row.
 * @param supportedOn - Targets with native support, or 'all'.
 * @returns One level per target, in `TARGET_TYPES` order.
 */
const row = (supportedOn: 'all' | readonly TargetType[]): Readonly<Record<TargetType, SupportLevel>> =>
  Object.fromEntries(TARGET_TYPES.map((target) => [
    target,
    supportedOn === 'all' || supportedOn.includes(target) ? 'native' : 'unsupported'
  ])) as Record<TargetType, SupportLevel>;

/** Support level per catalogued kind and target (same for both scopes). */
export const PRIMITIVE_SUPPORT_MATRIX: Readonly<Partial<Record<PrimitiveKind, Readonly<Record<TargetType, SupportLevel>>>>> = {
  prompt: row('all'),
  instruction: row('all'),
  'chat-mode': row('all'),
  agent: row('all'),
  skill: row('all'),
  hook: row('all'),
  'mcp-server': row('all'),
  steering: row(['kiro', 'kiro-cli']),
  spec: row(['kiro', 'kiro-cli']),
  command: row(['claude-code']),
  rule: row(['cursor']),
  'output-style': row(['claude-code']),
  tool: row(['opencode']),
  power: row(['kiro', 'kiro-cli', 'devin', 'devin-cli']),
  knowledge: row(['devin', 'devin-cli']),
  playbook: row(['devin', 'devin-cli'])
};

/**
 * Expected install status of a bundle on a target: all-or-nothing (O4).
 * @param kinds - Kinds of the bundle.
 * @param target - Target type.
 * @returns 'installed' when every kind is native/projected on the target, else 'rejected'.
 * @throws {Error} When a kind has no support-matrix row.
 */
export function expectedStatus(kinds: readonly PrimitiveKind[], target: TargetType): 'installed' | 'rejected' {
  let status: 'installed' | 'rejected' = 'installed';
  for (const kind of kinds) {
    const levels = PRIMITIVE_SUPPORT_MATRIX[kind];
    if (levels === undefined) {
      throw new Error(`no support-matrix row for ${kind}`);
    }
    if (levels[target] === 'unsupported') {
      status = 'rejected';
    }
  }
  return status;
}
