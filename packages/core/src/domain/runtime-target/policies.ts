/**
 * Runtime-target policies: selection validation, capability rejection and
 * shared-physical-output ownership analysis. Pure; no IO.
 * @module domain/runtime-target/policies
 */
import type {
  ExtractedFiles,
} from '../../ports/bundle-extractor';
import type {
  RuntimeModeSemantics,
} from '../../ports/runtime-projection-filesystem';
import type {
  ValidatedManifest,
} from '../collection/manifest-validator';
import {
  collectionKey,
  instanceKey,
  isSafeAbsolutePath,
  isSafeId,
  isTargetType,
} from './identity';
import type {
  RuntimeCollectionId,
  RuntimePayloadSnapshot,
  RuntimePlanConflict,
  RuntimeTargetInstance,
  RuntimeTargetSelectionInput,
  RuntimeTargetState,
} from './types';

/** Capability families target management refuses (rejected before any write). */
export const UNSUPPORTED_CAPABILITY_KINDS = ['mcp', 'plugin', 'hook', 'power', 'config'] as const;

/** Manifest fields that declare refused content. */
const UNSUPPORTED_MANIFEST_FIELDS = [
  'mcpServers', 'mcp', 'plugins', 'hooks', 'powers', 'config', 'settings'
] as const;

/** Bundle path prefixes that are refused content. */
const UNSUPPORTED_PATH_PREFIXES = ['plugins/', 'hooks/', 'powers/', 'mcp/'] as const;

/**
 * List refused capability content in a payload: manifest declarations and
 * payload files under refused prefixes. Empty array = supported.
 * @param manifest Validated manifest.
 * @param files Payload files.
 * @returns Human-readable refusal reasons.
 */
export interface UnsupportedPayloadOptions {
  /** Permit MCP declarations when the delivery has an MCP config adapter. */
  allowMcpServers?: boolean;
}

/**
 * List content categories rejected by the target projection policy.
 * @param manifest
 * @param files
 * @param options
 */
export function findUnsupportedPayloadContent(
  manifest: ValidatedManifest,
  files: ExtractedFiles,
  options: UnsupportedPayloadOptions = {}
): string[] {
  const reasons: string[] = [];
  const m = manifest as Record<string, unknown>;
  const mcpServers = m.mcpServers;
  const hasMcpServerDefinitions = mcpServers !== null
    && typeof mcpServers === 'object'
    && Object.keys(mcpServers).length > 0;
  const supportsMcpServers = options.allowMcpServers === true && hasMcpServerDefinitions;
  const unsupportedFields = options.allowMcpServers
    ? UNSUPPORTED_MANIFEST_FIELDS.filter((field) => field !== 'mcpServers')
    : UNSUPPORTED_MANIFEST_FIELDS;
  for (const field of unsupportedFields) {
    const value = m[field];
    if (value !== undefined && value !== null
      && !(Array.isArray(value) && value.length === 0)
      && !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) {
      reasons.push(`manifest declares unsupported "${field}" content`);
    }
  }
  const refusedKinds = new Set(['mcp', 'mcpserver', 'mcp-server', 'plugin', 'hook', 'power', 'config']);
  for (const listKey of ['items', 'prompts'] as const) {
    const list = m[listKey];
    if (Array.isArray(list)) {
      for (const entry of list) {
        const e = entry as Record<string, unknown>;
        const kind = (e.kind ?? e.type);
        if (typeof kind === 'string' && refusedKinds.has(kind.toLowerCase())) {
          reasons.push(`manifest item "${typeof e.path === 'string' ? e.path : ''}" declares unsupported kind "${kind}"`);
        }
      }
    }
  }
  const pathPrefixes = supportsMcpServers
    ? UNSUPPORTED_PATH_PREFIXES.filter((prefix) => prefix !== 'mcp/')
    : UNSUPPORTED_PATH_PREFIXES;
  for (const filePath of files.keys()) {
    const lower = filePath.toLowerCase();
    if (pathPrefixes.some((prefix) => lower.startsWith(prefix))) {
      reasons.push(`payload file "${filePath}" is under an unsupported capability prefix`);
    }
    if (lower === 'mcp.json' && !supportsMcpServers) {
      reasons.push(`payload file "${filePath}" is an MCP configuration file`);
    }
  }
  return reasons;
}

/**
 * Validate a selection input against session capabilities.
 * @param input Selection.
 * @param hasWorkspace Whether a concrete workspace root is available.
 * @returns Error message or null when valid.
 */
export function validateSelectionInput(
  input: RuntimeTargetSelectionInput,
  hasWorkspace: boolean
): string | null {
  if (!isTargetType(input.type)) {
    return `unknown target type "${String(input.type)}"; expected one of the built-in layout types`;
  }
  if ((input.scope as string) === 'workspace') {
    return 'scope "workspace" is not supported; use "user" or "repository"';
  }
  if (input.scope !== undefined && input.scope !== 'user' && input.scope !== 'repository') {
    return `unknown scope "${String(input.scope)}"; expected "user" or "repository"`;
  }
  if (input.scope === 'repository' && !hasWorkspace && input.path === undefined) {
    return 'repository scope requires a workspace root (--workspace-root or a workspace folder)';
  }
  if (input.userDefault === true && input.scope === 'repository') {
    return 'a repository-scoped selection cannot be the user default';
  }
  if (input.path !== undefined && !isSafeAbsolutePath(input.path)) {
    return `path override must be an absolute path: ${String(input.path)}`;
  }
  return null;
}

/**
 * Validate a source/collection identity component.
 * @param value
 * @param what
 */
export function requireSafeId(value: unknown, what: string): string {
  if (!isSafeId(value)) {
    throw new Error(`${what} is empty or unsafe: ${String(value)}`);
  }
  return value;
}

/**
 * Compare permission intent using the execution filesystem's capabilities.
 * @param left
 * @param right
 * @param semantics
 */
export function runtimeFileModesEqual(
  left: number | undefined,
  right: number | undefined,
  semantics: RuntimeModeSemantics = 'posix'
): boolean {
  const l = left ?? 0o644;
  const r = right ?? 0o644;
  if (semantics === 'readonly') {
    return Math.floor(l / 0o200) % 2 === Math.floor(r / 0o200) % 2;
  }
  return l === r;
}

/** One owner's expected bytes at a physical path. */
export interface PathOwner {
  receiptId: string;
  sha256: string;
  mode?: number;
}

/** Observed on-disk state of a planned path. */
export interface ObservedPath {
  exists: boolean;
  isSymlink: boolean;
  sha256?: string;
  mode?: number;
}

/**
 * Analyze one planned write against physical+receipt reality.
 * Returns a conflict object or a disposition.
 * @param plannedSha Expected installed bytes digest.
 * @param observed On-disk state (exists/isSymlink/sha256/mode).
 * @param owners Receipts (of ANY instance/collection) owning this path.
 * @param selfReceiptId Receipt being updated (its own prior record).
 * @param plannedMode
 * @param modeSemantics
 */
export function analyzePlannedWrite(
  plannedSha: string,
  observed: ObservedPath,
  owners: readonly PathOwner[],
  selfReceiptId: string | undefined,
  plannedMode?: number,
  modeSemantics: RuntimeModeSemantics = 'posix'
): { kind: 'write' } | { kind: 'shared' } | { kind: 'conflict'; conflict: RuntimePlanConflict } {
  const otherOwners = owners.filter((o) => o.receiptId !== selfReceiptId);
  const self = owners.find((o) => o.receiptId === selfReceiptId);

  if (observed.isSymlink) {
    return { kind: 'conflict', conflict: { code: 'PATH.SYMLINK', message: 'destination is a symlink; refusing to write through it' } };
  }

  if (otherOwners.length > 0) {
    // Another receipt owns this physical path: only identical expected bytes may share.
    for (const owner of otherOwners) {
      if (owner.sha256 !== plannedSha) {
        return {
          kind: 'conflict',
          conflict: {
            code: 'OWNERSHIP.BYTE_MISMATCH',
            message: `managed by receipt ${owner.receiptId} with different expected bytes`
          }
        };
      }
      if (!runtimeFileModesEqual(owner.mode, plannedMode, modeSemantics)) {
        return {
          kind: 'conflict',
          conflict: {
            code: 'OWNERSHIP.MODE_MISMATCH',
            message: `managed by receipt ${owner.receiptId} with different permission mode`
          }
        };
      }
      if (!observed.exists || observed.sha256 !== owner.sha256
        || (observed.mode !== undefined && !runtimeFileModesEqual(observed.mode, owner.mode, modeSemantics))) {
        return {
          kind: 'conflict',
          conflict: {
            code: 'OWNERSHIP.FOREIGN_DRIFT',
            message: `managed file for receipt ${owner.receiptId} is missing, modified or its mode changed`
          }
        };
      }
    }
    return { kind: 'shared' };
  }

  if (observed.exists) {
    if (self !== undefined) {
      // Updating own file: require observed bytes AND mode match the recorded install.
      if (observed.sha256 !== self.sha256
        || (observed.mode !== undefined && !runtimeFileModesEqual(observed.mode, self.mode, modeSemantics))) {
        return {
          kind: 'conflict',
          conflict: { code: 'TARGET.LOCALLY_MODIFIED', message: 'managed file was modified outside this ledger' }
        };
      }
      return { kind: 'write' };
    }
    // Unmanaged file always conflicts, even byte-identical — no adoption.
    return {
      kind: 'conflict',
      conflict: { code: 'TARGET.UNMANAGED_EXISTS', message: 'destination exists and is not managed by this ledger' }
    };
  }
  return { kind: 'write' };
}

/**
 * Whether a recorded output may be physically removed: observed bytes must
 * still match the recorded digest and no other receipt may own the path.
 * @param expected Recorded digest for this receipt's output.
 * @param observed On-disk state.
 * @param otherOwners Owners other than the receipt being removed/updated.
 * @param modeSemantics
 */
export function analyzeRemoval(
  expected: PathOwner,
  observed: ObservedPath,
  otherOwners: readonly PathOwner[],
  modeSemantics: RuntimeModeSemantics = 'posix'
): { kind: 'remove' } | { kind: 'keep-shared' } | { kind: 'preserve-modified' } | { kind: 'conflict'; conflict: RuntimePlanConflict } {
  if (otherOwners.length > 0) {
    return { kind: 'keep-shared' };
  }
  if (!observed.exists) {
    return { kind: 'remove' }; // already gone; drop the record
  }
  if (observed.isSymlink) {
    return {
      kind: 'conflict',
      conflict: { code: 'PATH.SYMLINK', message: 'recorded output is now a symlink; refusing removal' }
    };
  }
  if (observed.sha256 !== expected.sha256
    || (observed.mode !== undefined && !runtimeFileModesEqual(observed.mode, expected.mode, modeSemantics))) {
    return { kind: 'preserve-modified' };
  }
  return { kind: 'remove' };
}

/**
 * Pure projection-source policy (explicit `--from-target` or union).
 * Filters receipts BEFORE candidate selection when a source instance key is
 * given; explicit source never falls back to the union or imports.
 * No IO and no state mutation — callers merge `conflicts`, treat
 * `alreadyProjected` as preserved, and plan writes for `selected`.
 * @param state
 * @param active
 * @param sourceTargetId
 */
export function selectProjectionPayloads(
  state: RuntimeTargetState,
  active: RuntimeTargetInstance,
  sourceTargetId?: string
): {
  selected: { collection: RuntimeCollectionId; snapshot: RuntimePayloadSnapshot }[];
  alreadyProjected: RuntimeCollectionId[];
  conflicts: RuntimePlanConflict[];
} {
  const selected: { collection: RuntimeCollectionId; snapshot: RuntimePayloadSnapshot }[] = [];
  const alreadyProjected: RuntimeCollectionId[] = [];
  const conflicts: RuntimePlanConflict[] = [];
  const activeKey = instanceKey(active);

  // Candidate receipts: explicit source filters to that instance only.
  let receipts = Object.values(state.receipts);
  if (sourceTargetId !== undefined) {
    receipts = receipts.filter((r) => instanceKey(r.instance) === sourceTargetId);
    if (receipts.length === 0) {
      conflicts.push({
        code: 'PROJECT.SOURCE_MISSING',
        message: `source target ${sourceTargetId} has no installed collections`
      });
      return { selected, alreadyProjected, conflicts };
    }
  }

  const candidates = new Map<string, { collection: RuntimeCollectionId; payloadIds: Set<string> }>();
  const addCand = (collection: RuntimeCollectionId, payloadId: string): void => {
    const key = collectionKey(collection);
    const c = candidates.get(key) ?? { collection, payloadIds: new Set() };
    c.payloadIds.add(payloadId);
    candidates.set(key, c);
  };
  for (const r of receipts) {
    addCand(r.collection, r.payloadId);
  }
  // Imports count only for the union case — never for an explicit source.
  if (sourceTargetId === undefined) {
    for (const i of Object.values(state.imports)) {
      addCand({ sourceId: i.sourceId, manifestId: i.manifestId }, i.payloadId);
    }
  }

  const activeReceipts = Object.values(state.receipts).filter(
    (r) => instanceKey(r.instance) === activeKey
  );
  for (const [key, cand] of candidates) {
    if (cand.payloadIds.size > 1) {
      conflicts.push({
        code: 'PROJECT.AMBIGUOUS',
        message: `${cand.collection.manifestId} has distinct snapshots; pass --from-target`
      });
      continue;
    }
    const payloadId = [...cand.payloadIds][0];
    const snapshot = state.payloads[payloadId];
    if (snapshot === undefined) {
      conflicts.push({ code: 'PAYLOAD.MISSING', message: `payload ${payloadId} missing; reacquire the source` });
      continue;
    }
    const existing = activeReceipts.find((r) => collectionKey(r.collection) === key);
    if (existing !== undefined && existing.payloadId === payloadId) {
      alreadyProjected.push(cand.collection);
      continue;
    }
    if (existing !== undefined && existing.payloadId !== payloadId) {
      conflicts.push({
        code: 'COLLECTION.VERSION_CONFLICT',
        message: `${cand.collection.manifestId} is installed at a different snapshot; use update`
      });
      continue;
    }
    selected.push({ collection: cand.collection, snapshot });
  }
  return { selected, alreadyProjected, conflicts };
}
