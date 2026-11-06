/**
 * Domain layer — primitive diagnostics support matrix.
 *
 * Which kind each target supports, as observed after #532. A cell the
 * product should support but rejects today is `native` and covered by a
 * known gap (`kiro-hook-rejected`, `kiro-plugin-rejected`, `mcp-server-rejected`).
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
import type {
  DiagnosticInstallMode,
} from './types';

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
  plugin: row('all'),
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
 * The default `install` is all-or-nothing: a bundle with any kind the
 * target does not support is `rejected`, which is the documented outcome.
 * `partial` exists only for the opt-in `install --skip-unsupported` (#550):
 * the supported items install and the others are reported as skipped.
 */
export type ExpectedInstallStatus = 'installed' | 'partial' | 'rejected';

/**
 * Expected install status of a bundle on a target, in an install mode.
 * @param kinds - Kinds of the bundle.
 * @param target - Target type.
 * @param mode - Install mode; default `'default'` (all-or-nothing).
 * @returns 'installed' when every kind is native/projected on the target.
 * Otherwise, in the default mode, 'rejected'; with `skip-unsupported`,
 * 'rejected' when no kind is supported, else 'partial'. A single-kind
 * bundle is never 'partial'.
 * @throws {Error} When a kind has no support-matrix row.
 */
export function expectedStatus(
  kinds: readonly PrimitiveKind[],
  target: TargetType,
  mode: DiagnosticInstallMode = 'default'
): ExpectedInstallStatus {
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
  return mode === 'default' || supported === 0 ? 'rejected' : 'partial';
}
