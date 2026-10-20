/**
 * Domain layer — primitive diagnostics sandbox rules.
 *
 * Path containment, sandbox path labelling (`$HOME/…`, `$XDG_*`/…,
 * `$TMPDIR/…`, `<workspace>/…`, `<case>/…`), the bookkeeping rule that
 * separates APH's own state from user-facing writes, snapshot diffs and the
 * containment check run before any command. Pure functions: no I/O.
 *
 * The bookkeeping names are literals, because core cannot import app or
 * infra; an app drift-guard test labels the real constants and resolvers.
 * @module domain/diagnostics/primitives/sandbox
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import type {
  PreparedSandbox,
  SnapshotRoot,
} from '../../../ports/primitive-diagnostics-driver';

/** Sandbox snapshot: label → sha256 hex of the file bytes. */
export type Snapshot = ReadonlyMap<string, string>;

/**
 * Whether `p` is `root` or inside it, by path segments (never a string prefix).
 * @param root - Absolute directory.
 * @param p - Absolute path.
 * @returns True when `p` is `root` or below it.
 */
export function isInside(root: string, p: string): boolean {
  const r = path.relative(root, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/**
 * Label an absolute path with the longest root that contains it.
 * @param roots - Labelled roots.
 * @param absolute - Absolute path.
 * @returns `${label}/${relative}` with `/` separators, the bare label for the root itself,
 * or undefined outside every root.
 */
export function labelSandboxPath(roots: readonly SnapshotRoot[], absolute: string): string | undefined {
  let best: SnapshotRoot | undefined;
  for (const root of roots) {
    if (isInside(root.path, absolute) && (best === undefined || root.path.length > best.path.length)) {
      best = root;
    }
  }
  if (best === undefined) {
    return undefined;
  }
  const relative = path.relative(best.path, absolute).split(path.sep).join('/');
  return relative === '' ? best.label : `${best.label}/${relative}`;
}

/** APH's own sub-directory under each XDG base dir (infra `APP_SUBDIR`). */
const APP_SUBDIR = 'ai-primitives-hub';
const XDG_APP_LABELS = ['$XDG_CONFIG_HOME', '$XDG_DATA_HOME', '$XDG_CACHE_HOME', '$XDG_STATE_HOME'] as const;
const SCRATCH_LABELS = ['$XDG_RUNTIME_DIR', '$TMPDIR'] as const;
const WORKSPACE_BOOKKEEPING_FILES: ReadonlySet<string> = new Set([
  'ai-primitives-hub.yml',
  'ai-primitives-hub.yaml',
  'prompt-registry.lock.json',
  'prompt-registry.local.lock.json'
]);
const STATE_DIR = '.ai-primitives-hub';

/**
 * Whether a sandbox label is APH bookkeeping rather than a user-facing write.
 * `<case>/…` is never bookkeeping.
 * @param label - Sandbox label.
 * @returns True for APH state, lockfiles, project config, scratch dirs and `.git/**`.
 */
export function isBookkeepingLabel(label: string): boolean {
  const [root, ...rest] = label.split('/');
  if (root === '<case>') {
    return false;
  }
  if (rest.includes('.git')) {
    return true;
  }
  if ((SCRATCH_LABELS as readonly string[]).includes(root)) {
    return true;
  }
  if ((XDG_APP_LABELS as readonly string[]).includes(root)) {
    return rest[0] === APP_SUBDIR;
  }
  if (root === '<workspace>') {
    return (rest.length === 1 && WORKSPACE_BOOKKEEPING_FILES.has(rest[0])) || rest[0] === STATE_DIR;
  }
  if (root === '$HOME') {
    return rest[0] === STATE_DIR;
  }
  return false;
}

/** Labels that differ between two snapshots, each list sorted. */
export interface SnapshotDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

/**
 * Diff two snapshots.
 * @param before - Earlier snapshot.
 * @param after - Later snapshot.
 * @returns Sorted added, modified and removed labels.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [label, digest] of after) {
    const previous = before.get(label);
    if (previous === undefined) {
      added.push(label);
    } else if (previous !== digest) {
      modified.push(label);
    }
  }
  for (const label of before.keys()) {
    if (!after.has(label)) {
      removed.push(label);
    }
  }
  return { added: added.toSorted(), modified: modified.toSorted(), removed: removed.toSorted() };
}

/**
 * SHA-256 of bytes.
 * @param bytes - Content.
 * @returns Lowercase hex digest.
 */
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Check that a prepared sandbox cannot write outside its case root.
 * @param sandbox - Prepared sandbox.
 * @returns The names of every `userDirs` entry and every `storage.<key>` value outside
 * `sandbox.root`; empty when contained.
 */
export function checkSandboxContainment(sandbox: PreparedSandbox): string[] {
  const escaped: string[] = [];
  for (const [name, dir] of Object.entries(sandbox.userDirs)) {
    if (!isInside(sandbox.root, dir)) {
      escaped.push(name);
    }
  }
  for (const [key, value] of Object.entries(sandbox.storage)) {
    if (!isInside(sandbox.root, value)) {
      escaped.push(`storage.${key}`);
    }
  }
  return escaped;
}
