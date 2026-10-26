/**
 * Domain layer — primitive diagnostics support matrix.
 *
 * Which isolated kind each target supports, as observed after #532. A
 * cell the product should support but rejects today is `native` and
 * covered by a known gap (`kiro-hook-rejected`, `mcp-server-rejected`).
 * chat-mode on copilot-cli installs since #526. `projected` (installed
 * through a projection onto another kind) is reserved and unused here.
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
 * Expected install status of a bundle on a target.
 *
 * `partial` is the contract for a bundle that mixes kinds the target
 * supports with kinds it does not: the supported items install and the
 * others are reported. The doctor runs the default all-or-nothing
 * `install`, so a `partial` case is rejected and reported as a known gap;
 * `install --skip-unsupported` (#550) is the opt-in partial install.
 */
export type ExpectedInstallStatus = 'installed' | 'partial' | 'rejected';

/**
 * Expected install status of a bundle on a target.
 * @param kinds - Kinds of the bundle.
 * @param target - Target type.
 * @returns 'installed' when every kind is native/projected on the target, 'rejected' when
 * none is, else 'partial'. A single-kind bundle is never 'partial'.
 * @throws {Error} When a kind has no support-matrix row.
 */
export function expectedStatus(kinds: readonly PrimitiveKind[], target: TargetType): ExpectedInstallStatus {
  let supported = 0;
  for (const kind of kinds) {
    const levels = PRIMITIVE_SUPPORT_MATRIX[kind];
    if (levels === undefined) {
      throw new Error(`no support-matrix row for ${kind}`);
    }
    if (levels[target] !== 'unsupported') {
      supported += 1;
    }
  }
  if (supported === kinds.length) {
    return 'installed';
  }
  return supported === 0 ? 'rejected' : 'partial';
}
