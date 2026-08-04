/**
 * Domain layer — multi-target install destinations.
 *
 * New in `ai-primitives-hub-next` (no equivalent exists on `main` today):
 * a `Target` is a typed, named install destination, generalizing beyond
 * VS Code so `cli install` can write to Kiro/Windsurf/Claude Code/GitHub
 * Copilot CLI too. In scope per migration plan §8 decision 5 — ported
 * from the reference branch's `Target` union
 * (`docs/library-centric-architecture` design), with `scope` unified to
 * this package's own `InstallationScope` (`./types.ts`) instead of the
 * reference branch's narrower `user | repository`, so a `Target` behaves
 * exactly like every other install destination in `core` — no separate
 * scope model to reconcile later. Whether a given target type actually
 * supports every scope value is a validation concern for whatever
 * consumes this type (`app`, Phase 4), not a type-system constraint here.
 * @module domain/install/target
 */
import type {
  PrimitiveKind,
} from '../primitive/types';
import {
  isPrimitiveKind,
} from '../primitive/types';
import type {
  InstallationScope,
  RepositoryCommitMode,
} from './types';

/**
 * All target types known to `ai-primitives-hub-next`.
 */
export const TARGET_TYPES = [
  'vscode',
  'vscode-insiders',
  'copilot-cli',
  'kiro',
  'kiro-cli',
  'windsurf',
  'claude-code',
  'cursor',
  'opencode',
  'devin',
  'devin-cli'
] as const;

/**
 * Target type discriminant.
 */
export type TargetType = typeof TARGET_TYPES[number];

/**
 * Fields common to every target, regardless of type.
 */
export interface TargetBase {
  /** Unique identifier, looked up by `install --target <name>`. */
  name: string;
  type: TargetType;
  scope: InstallationScope;
  /** Required when `scope` is `'repository'`. */
  commitMode?: RepositoryCommitMode;
  /** Workspace/repository root path; required when `scope` is not `'user'`. */
  rootPath?: string;
  /** Override the platform-default config path for this target. */
  path?: string;
  /** Restrict which primitive kinds this target accepts, e.g. `['prompt', 'agent']`. */
  allowedKinds?: PrimitiveKind[];
}

export interface VsCodeTarget extends TargetBase {
  type: 'vscode' | 'vscode-insiders';
}

export interface CopilotCliTarget extends TargetBase {
  type: 'copilot-cli';
}

export interface KiroTarget extends TargetBase {
  type: 'kiro';
}

export interface KiroCliTarget extends TargetBase {
  type: 'kiro-cli';
}

export interface WindsurfTarget extends TargetBase {
  type: 'windsurf';
}

export interface ClaudeCodeTarget extends TargetBase {
  type: 'claude-code';
}

export interface CursorTarget extends TargetBase {
  type: 'cursor';
}

export interface OpencodeTarget extends TargetBase {
  type: 'opencode';
}

export interface DevinTarget extends TargetBase {
  type: 'devin';
}

export interface DevinCliTarget extends TargetBase {
  type: 'devin-cli';
}

/**
 * Tagged union of every target type.
 */
export type Target =
  | VsCodeTarget
  | CopilotCliTarget
  | KiroTarget
  | KiroCliTarget
  | WindsurfTarget
  | ClaudeCodeTarget
  | CursorTarget
  | OpencodeTarget
  | DevinTarget
  | DevinCliTarget;

const INSTALLATION_SCOPES: readonly string[] = ['user', 'workspace', 'repository'];
const COMMIT_MODES: readonly string[] = ['commit', 'local-only'];

/**
 * Type guard for `Target`. Pure; no IO — safe to use directly against
 * parsed YAML/JSON config nodes.
 * @param value - Candidate value, typically a parsed config node.
 * @returns true iff `value` matches the `Target` shape.
 */
export function isTarget(value: unknown): value is Target {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
    return false;
  }
  if (typeof candidate.type !== 'string' || !(TARGET_TYPES as readonly string[]).includes(candidate.type)) {
    return false;
  }
  if (candidate.scope !== undefined && !INSTALLATION_SCOPES.includes(candidate.scope as string)) {
    return false;
  }
  if (candidate.commitMode !== undefined && !COMMIT_MODES.includes(candidate.commitMode as string)) {
    return false;
  }
  if (candidate.allowedKinds !== undefined
    && (!Array.isArray(candidate.allowedKinds)
      || candidate.allowedKinds.some((kind) => !isPrimitiveKind(kind)))) {
    return false;
  }
  return true;
}
