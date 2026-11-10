/**
 * RuntimeTargetState shape + structural validation. Pure; no IO.
 * Reject malformed state — only ENOENT means empty.
 * @module domain/runtime-target/state
 */
import * as path from 'node:path';
import {
  isRuntimeSelection,
  isSafeAbsolutePath,
  isSafeId,
  isSafeRelativePath,
  isTargetType,
} from './identity';
import {
  isRuntimeMode,
  runtimePayloadId,
  validateRuntimePayload,
} from './payload';
import type {
  RuntimeImportRef,
  RuntimePayloadSnapshot,
  RuntimeProjectionReceipt,
  RuntimeSelection,
  RuntimeTargetState,
} from './types';

/**
 * Decode/validate helper.
 */
export function emptyRuntimeTargetState(): RuntimeTargetState {
  return {
    schemaVersion: 1,
    revision: 0,
    selections: { workspaces: {} },
    payloads: {},
    imports: {},
    receipts: {}
  };
}

const fail = (why: string): never => {
  throw new Error(`runtime-target state invalid: ${why}`);
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownEntries(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record).filter(([key]) => Object.prototype.hasOwnProperty.call(record, key));
}

function validateSnapshot(raw: unknown, id: string): RuntimePayloadSnapshot {
  if (!isPlainRecord(raw)) {
    fail(`payload ${String(id)} is not an object`);
  }
  const s = raw as Record<string, unknown>;
  if (s.payloadId !== id || !isSafeId(s.payloadId)) {
    fail(`payload ${String(id)} has mismatched/unsafe payloadId`);
  }
  if (!isSafeId(s.sourceId) || !isSafeId(s.manifestId) || typeof s.version !== 'string' || s.version.length === 0) {
    fail(`payload ${String(id)} has unsafe identity/version`);
  }
  if (!isPlainRecord(s.manifest) || typeof s.manifest.id !== 'string' || s.manifest.id !== s.manifestId) {
    fail(`payload ${String(id)} manifest missing or mismatched id`);
  }
  if (typeof s.createdAt !== 'string') {
    fail(`payload ${String(id)} missing createdAt`);
  }
  if (!(s.files instanceof Map)) {
    fail(`payload ${String(id)} files is not a Map`);
  }
  const files = new Map<string, Uint8Array>();
  for (const [filePath, bytes] of s.files as Map<unknown, unknown>) {
    if (!isSafeRelativePath(filePath) || !(bytes instanceof Uint8Array)) {
      fail(`payload ${String(id)} has unsafe file entry ${String(filePath)}`);
    }
    files.set(filePath as string, bytes as Uint8Array);
  }
  const validated = validateRuntimePayload(files, s.sourceId as string, {
    id: s.manifestId as string, version: s.version as string
  });
  if (runtimePayloadId(s.sourceId as string, validated.manifest, validated.files) !== id
    || (s.manifest as Record<string, unknown>).version !== s.version) {
    fail(`payload ${String(id)} identity/digest mismatch`);
  }
  return {
    payloadId: s.payloadId as string,
    sourceId: s.sourceId as string,
    manifestId: s.manifestId as string,
    version: s.version as string,
    manifest: validated.manifest,
    files: validated.files,
    createdAt: s.createdAt as string
  };
}

function validateImport(raw: unknown, id: string): RuntimeImportRef {
  if (!isPlainRecord(raw)) {
    fail(`import ${String(id)} is not an object`);
  }
  const s = raw as Record<string, unknown>;
  if (s.importId !== id || !isSafeId(s.importId) || !isSafeId(s.payloadId)
    || !isSafeId(s.sourceId) || !isSafeId(s.manifestId)
    || typeof s.provenance !== 'string' || typeof s.importedAt !== 'string') {
    fail(`import ${String(id)} has unsafe fields`);
  }
  if (s.legacyRef !== undefined && typeof s.legacyRef !== 'string') {
    fail(`import ${String(id)} legacyRef invalid`);
  }
  return s as unknown as RuntimeImportRef;
}

function validateReceipt(raw: unknown, id: string): RuntimeProjectionReceipt {
  if (!isPlainRecord(raw)) {
    fail(`receipt ${String(id)} is not an object`);
  }
  const s = raw as Record<string, unknown>;
  if (s.receiptId !== id || !isSafeId(s.receiptId) || !isSafeId(s.payloadId) || typeof s.version !== 'string'
    || typeof s.installedAt !== 'string') {
    fail(`receipt ${String(id)} has unsafe fields`);
  }
  if (!isPlainRecord(s.instance) || !isTargetType(s.instance.type)
    || (s.instance.scope !== 'user' && s.instance.scope !== 'repository')
    || !isSafeAbsolutePath(s.instance.root)) {
    fail(`receipt ${String(id)} has unsafe instance`);
  }
  if (!isPlainRecord(s.collection) || !isSafeId(s.collection.sourceId) || !isSafeId(s.collection.manifestId)) {
    fail(`receipt ${String(id)} has unsafe collection`);
  }
  if (!isPlainRecord(s.outputs)) {
    fail(`receipt ${String(id)} outputs is not an object`);
  }
  const instance = s.instance as RuntimeProjectionReceipt['instance'];
  if (s.contextRoot !== undefined
    && (!isSafeAbsolutePath(s.contextRoot) || instance.scope !== 'repository')) {
    fail(`receipt ${String(id)} invalid repository context`);
  }
  if (s.commitMode !== undefined
    && (instance.scope !== 'repository' || (s.commitMode !== 'commit' && s.commitMode !== 'local-only'))) {
    fail(`receipt ${String(id)} invalid commit mode`);
  }
  if (s.registryRef !== undefined && (!isPlainRecord(s.registryRef)
    || !isSafeId(s.registryRef.bundleId) || !isSafeId(s.registryRef.sourceType))) {
    fail(`receipt ${String(id)} invalid registry reference`);
  }
  if (s.source !== undefined && (!isPlainRecord(s.source)
    || typeof s.source.type !== 'string' || typeof s.source.url !== 'string')) {
    fail(`receipt ${String(id)} invalid source`);
  }
  const outputs: RuntimeProjectionReceipt['outputs'] = {};
  for (const [outPath, out] of ownEntries(s.outputs as Record<string, unknown>)) {
    if (!isSafeAbsolutePath(outPath)) {
      fail(`receipt ${String(id)} has unsafe output path ${String(outPath)}`);
    }
    const o = out as Record<string, unknown>;
    if (!isPlainRecord(out) || typeof o.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(o.sha256)) {
      fail(`receipt ${String(id)} output ${String(outPath)} has invalid digest`);
    }
    if (o.mode !== undefined && !isRuntimeMode(o.mode)) {
      fail(`receipt ${String(id)} output ${String(outPath)} has invalid mode`);
    }
    if (o.sourcePath !== undefined && !isSafeRelativePath(o.sourcePath)) {
      fail(`receipt ${String(id)} output ${String(outPath)} has invalid sourcePath`);
    }
    const relative = path.relative((s.instance as { root: string }).root, outPath);
    if (!isSafeRelativePath(relative.split(path.sep).join('/'))) {
      fail(`receipt ${String(id)} output ${String(outPath)} escapes its instance root`);
    }
    outputs[outPath] = {
      sha256: o.sha256 as string,
      ...(o.mode === undefined ? {} : { mode: o.mode as number }),
      ...(o.sourcePath === undefined ? {} : { sourcePath: o.sourcePath as string })
    };
  }
  return {
    receiptId: s.receiptId as string,
    instance: s.instance as RuntimeProjectionReceipt['instance'],
    collection: s.collection as RuntimeProjectionReceipt['collection'],
    payloadId: s.payloadId as string,
    version: s.version as string,
    outputs,
    installedAt: s.installedAt as string,
    ...(s.contextRoot === undefined ? {} : { contextRoot: s.contextRoot as string }),
    ...(s.commitMode === undefined ? {} : { commitMode: s.commitMode as RuntimeProjectionReceipt['commitMode'] }),
    ...(s.registryRef === undefined ? {} : { registryRef: s.registryRef as unknown as RuntimeProjectionReceipt['registryRef'] }),
    ...(s.source === undefined ? {} : { source: s.source as unknown as RuntimeProjectionReceipt['source'] })
  };
}

/**
 * Validate a fully decoded state object (files already Map<string,Uint8Array>).
 * @param raw Candidate state.
 * @returns Validated state.
 * @throws {Error} On any malformed field — never repairs silently.
 */
export function validateRuntimeTargetState(raw: unknown): RuntimeTargetState {
  if (!isPlainRecord(raw)) {
    fail('state is not an object');
  }
  const s = raw as Record<string, unknown>;
  if (s.schemaVersion !== 1) {
    fail(`unsupported schemaVersion ${String(s.schemaVersion)}`);
  }
  if (typeof s.revision !== 'number' || !Number.isInteger(s.revision) || s.revision < 0) {
    fail('revision must be a non-negative integer');
  }
  if (!isPlainRecord(s.selections) || !isPlainRecord(s.selections.workspaces)) {
    fail('selections malformed');
  }
  const selections = s.selections as Record<string, unknown>;
  const workspacesRaw = selections.workspaces as Record<string, unknown>;
  const workspaces: Record<string, RuntimeTargetState['selections']['workspaces'][string]> = Object.create(null);
  for (const [root, sel] of ownEntries(workspacesRaw)) {
    if (!isSafeAbsolutePath(root) || !isRuntimeSelection(sel)) {
      fail(`selection for workspace ${root} malformed`);
    }
    workspaces[root] = { type: (sel as RuntimeSelection).type };
  }
  const userDefault = selections.userDefault;
  if (userDefault !== undefined && !isRuntimeSelection(userDefault)) {
    fail('userDefault selection malformed');
  }
  if (s.repositories !== undefined
    && (!Array.isArray(s.repositories) || !s.repositories.every(isSafeAbsolutePath))) {
    fail('repository index must contain absolute paths');
  }

  if (!isPlainRecord(s.payloads) || !isPlainRecord(s.imports) || !isPlainRecord(s.receipts)) {
    fail('payloads/imports/receipts must be objects');
  }
  const payloads: Record<string, RuntimePayloadSnapshot> = Object.create(null);
  for (const [id, snap] of ownEntries(s.payloads as Record<string, unknown>)) {
    if (!isSafeId(id)) {
      fail(`unsafe payload key ${String(id)}`);
    }
    payloads[id] = validateSnapshot(snap, id);
  }
  const imports: Record<string, RuntimeImportRef> = Object.create(null);
  for (const [id, ref] of ownEntries(s.imports as Record<string, unknown>)) {
    if (!isSafeId(id)) {
      fail(`unsafe import key ${String(id)}`);
    }
    imports[id] = validateImport(ref, id);
    const payload = payloads[imports[id].payloadId];
    if (payload === undefined || payload.sourceId !== imports[id].sourceId || payload.manifestId !== imports[id].manifestId) {
      fail(`import ${String(id)} references a missing or mismatched payload`);
    }
  }
  const receipts: Record<string, RuntimeProjectionReceipt> = Object.create(null);
  for (const [id, rec] of ownEntries(s.receipts as Record<string, unknown>)) {
    if (!isSafeId(id)) {
      fail(`unsafe receipt key ${String(id)}`);
    }
    receipts[id] = validateReceipt(rec, id);
    const receipt = receipts[id];
    // A missing payload is allowed (unavailable until re-acquired); a present
    // one must match the receipt's identity.
    const payload = payloads[receipt.payloadId];
    if (payload !== undefined && (payload.sourceId !== receipt.collection.sourceId
      || payload.manifestId !== receipt.collection.manifestId || payload.version !== receipt.version)) {
      fail(`receipt ${String(id)} references a mismatched payload`);
    }
  }
  return {
    schemaVersion: 1,
    revision: s.revision as number,
    selections: {
      workspaces,
      ...(userDefault === undefined || userDefault === null ? {} : { userDefault: { type: (userDefault as RuntimeSelection).type } })
    },
    payloads,
    imports,
    receipts,
    ...(s.repositories === undefined ? {} : { repositories: [...new Set(s.repositories as string[])].toSorted() })
  };
}
