/**
 * v3 multi-target lockfile codec. Pure; no IO.
 * The lockfile holds installation records only: no payload bytes, no
 * selections, no revision. `bundles`/`tools`/`instances` keys are stable
 * hashes; `sources` records where each collection can be re-acquired.
 * Repository file paths are workspace-relative, user file paths are relative
 * to the instance root. Flat in-memory receipts are a codec projection.
 * @module domain/runtime-target/lockfile-v3
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import {
  TARGET_TYPES,
  type TargetType,
} from '../install/target';
import {
  isSafeAbsolutePath,
  isSafeId,
  isSafeRelativePath,
} from './identity';
import {
  isRuntimeMode,
} from './payload';
import type {
  RuntimeProjectionReceipt,
  RuntimeSourceInfo,
  RuntimeTargetState,
} from './types';

export const LOCKFILE_V3_VERSION = '3.0.0';
export const LOCKFILE_V3_FILENAME = 'ai-primitives-hub.lock.json';
export const LOCKFILE_V3_SCHEMA_ID = 'https://raw.githubusercontent.com/AmadeusITGroup/ai-primitives-hub/main/packages/core/src/public/schemas/lockfile.schema.json';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export const lockfileBundleKey = (sourceId: string, manifestId: string): string =>
  `bundle-${sha(JSON.stringify([sourceId, manifestId])).slice(0, 24)}`;
/** Instance root as persisted: repository roots are relative to the repository so identities survive a move. */
export const persistedInstanceRoot = (scope: string, root: string, contextRoot?: string): string => {
  if (scope !== 'repository' || contextRoot === undefined) {
    return root;
  }
  const rel = path.relative(contextRoot, root).split(path.sep).join('/');
  return rel === '' ? '.' : rel;
};

export const runtimeReceiptId = (type: string, scope: string, root: string, sourceId: string, manifestId: string, contextRoot?: string): string =>
  `rcpt-${sha(JSON.stringify([type, scope, persistedInstanceRoot(scope, root, contextRoot), sourceId, manifestId])).slice(0, 24)}`;

export const lockfileInstanceKey = (type: string, scope: string, root: string): string =>
  `inst-${sha(JSON.stringify([type, scope, root])).slice(0, 24)}`;

interface V3FileEntry { path: string; checksum: string; mode?: number; sourcePath?: string }
interface V3Instance {
  scope: 'user' | 'repository';
  /** Absolute for user scope; repository-relative (e.g. `.kiro`) for repository scope. */
  root: string;
  version: string;
  installationId: string;
  payloadId: string;
  installedAt: string;
  files: V3FileEntry[];
}
interface V3Bundle {
  sourceId: string;
  manifestId: string;
  bundleId: string;
  tools: Partial<Record<TargetType, { instances: Record<string, V3Instance> }>>;
}
export interface RuntimeMultiTargetLockfile {
  $schema: string;
  version: typeof LOCKFILE_V3_VERSION;
  generatedAt: string;
  generatedBy: string;
  sources: Record<string, RuntimeSourceInfo>;
  bundles: Record<string, V3Bundle>;
}

/** Records recovered from one lockfile document. */
export interface RuntimeLockfileRecords {
  receipts: Record<string, RuntimeProjectionReceipt>;
  sources: Record<string, RuntimeSourceInfo>;
}

const TOP_LEVEL_KEYS = new Set(['$schema', 'version', 'generatedAt', 'generatedBy', 'sources', 'bundles']);

const fail = (why: string): never => {
  throw new Error(`lockfile invalid: ${why}`);
};
const isRec = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Base directory recorded file paths are relative to. */
const recordBase = (receipt: Pick<RuntimeProjectionReceipt, 'instance' | 'contextRoot'>): string => {
  if (receipt.instance.scope === 'user') {
    return receipt.instance.root;
  }
  if (receipt.contextRoot === undefined) {
    return fail('repository receipt has no context root');
  }
  return receipt.contextRoot;
};

const sourceOf = (receipt: RuntimeProjectionReceipt): RuntimeSourceInfo =>
  receipt.source ?? { type: receipt.registryRef?.sourceType ?? 'unknown', url: '' };

/**
 * Encode receipts to the persisted v3 records shape. Receipt outputs
 * (absolute) become base-relative file entries; an output outside its base
 * fails the encode rather than writing an unsafe record.
 * @param state Receipts to record.
 * @param generatedBy Tool identity, e.g. `ai-primitives-hub@1.2.3`.
 */
export function encodeLockfileV3(state: Pick<RuntimeTargetState, 'receipts'>, generatedBy: string): RuntimeMultiTargetLockfile {
  const bundles: Record<string, V3Bundle> = {};
  const sources: Record<string, RuntimeSourceInfo> = {};
  const explicit = new Map<string, boolean>();
  const receipts = Object.values(state.receipts).toSorted((a, b) => a.receiptId.localeCompare(b.receiptId));
  for (const r of receipts) {
    if (sources[r.collection.sourceId] === undefined || (r.source !== undefined && explicit.get(r.collection.sourceId) !== true)) {
      sources[r.collection.sourceId] = sourceOf(r);
      explicit.set(r.collection.sourceId, r.source !== undefined);
    }
    const bkey = lockfileBundleKey(r.collection.sourceId, r.collection.manifestId);
    const bundle = bundles[bkey] ??= {
      sourceId: r.collection.sourceId,
      manifestId: r.collection.manifestId,
      bundleId: r.registryRef?.bundleId ?? r.collection.manifestId,
      tools: {}
    };
    const tool = bundle.tools[r.instance.type] ??= { instances: {} };
    const base = recordBase(r);
    const files: V3FileEntry[] = Object.entries(r.outputs).map(([abs, o]) => {
      const rel = path.relative(base, abs);
      if (rel.length === 0 || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        fail(`receipt ${r.receiptId} output escapes its base: ${abs}`);
      }
      return {
        path: rel.split(path.sep).join('/'),
        checksum: o.sha256,
        ...(o.mode === undefined ? {} : { mode: o.mode }),
        ...(o.sourcePath === undefined ? {} : { sourcePath: o.sourcePath })
      };
    }).toSorted((a, b) => a.path.localeCompare(b.path));
    const storedRoot = persistedInstanceRoot(r.instance.scope, r.instance.root, r.contextRoot);
    tool.instances[lockfileInstanceKey(r.instance.type, r.instance.scope, storedRoot)] = {
      scope: r.instance.scope,
      root: storedRoot,
      version: r.version,
      installationId: r.receiptId,
      payloadId: r.payloadId,
      installedAt: r.installedAt,
      files
    };
  }
  return {
    $schema: LOCKFILE_V3_SCHEMA_ID,
    version: LOCKFILE_V3_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy,
    sources,
    bundles
  };
}

/**
 * Decode+validate a v3 lockfile into flat receipts. Structural + referential
 * validation (safe paths/identities, checksum format, scope/type enums,
 * installation id integrity). Throws on any malformed field.
 * @param raw Parsed document.
 * @param options Authority context for repository documents.
 * @param options.repositoryRoot Canonical repository root recorded paths resolve against.
 */
export function decodeLockfileV3(raw: unknown, options: { repositoryRoot?: string } = {}): RuntimeLockfileRecords {
  if (!isRec(raw)) {
    fail('not an object');
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== LOCKFILE_V3_VERSION) {
    fail(`unsupported version ${String(o.version)}`);
  }
  for (const key of Object.keys(o)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      fail(`unexpected top-level section ${key}`);
    }
  }
  if (typeof o.$schema !== 'string' || typeof o.generatedBy !== 'string'
    || typeof o.generatedAt !== 'string' || Number.isNaN(Date.parse(o.generatedAt))) {
    fail('schema/generation metadata missing or invalid');
  }
  if (!isRec(o.bundles) || !isRec(o.sources)) {
    fail('bundles/sources missing');
  }
  const sources: Record<string, RuntimeSourceInfo> = Object.create(null);
  for (const [id, src0] of Object.entries(o.sources as Record<string, unknown>)) {
    const src = src0 as Record<string, unknown>;
    if (!isSafeId(id) || !isRec(src) || typeof src.type !== 'string' || typeof src.url !== 'string') {
      fail(`unsafe source ${id}`);
    }
    sources[id] = { type: src.type as string, url: src.url as string };
  }
  const receipts: Record<string, RuntimeProjectionReceipt> = Object.create(null);
  for (const [bkey, bundle0] of Object.entries(o.bundles as Record<string, unknown>)) {
    const bundle = bundle0 as Record<string, unknown>;
    if (!isRec(bundle) || !isSafeId(bundle.sourceId) || !isSafeId(bundle.manifestId)
      || !isSafeId(bundle.bundleId) || !isRec(bundle.tools)) {
      fail(`unsafe bundle ${bkey}`);
    }
    if (bkey !== lockfileBundleKey(bundle.sourceId as string, bundle.manifestId as string)) {
      fail(`bundle key ${bkey} does not match its identity`);
    }
    const sourceId = bundle.sourceId as string;
    const source = sources[sourceId];
    if (source === undefined) {
      fail(`bundle ${bkey} references unrecorded source ${sourceId}`);
    }
    const collection = { sourceId, manifestId: bundle.manifestId as string };
    for (const [type, tool0] of Object.entries(bundle.tools as Record<string, unknown>)) {
      const tool = tool0 as Record<string, unknown>;
      if (!(TARGET_TYPES as readonly string[]).includes(type) || !isRec(tool) || !isRec(tool.instances)) {
        fail(`bundle ${bkey} unsafe tool ${type}`);
      }
      for (const [ikey, inst0] of Object.entries(tool.instances as Record<string, unknown>)) {
        const inst = inst0 as Record<string, unknown>;
        if (!isRec(inst) || (inst.scope !== 'user' && inst.scope !== 'repository')
          || typeof inst.root !== 'string' || typeof inst.version !== 'string'
          || !isSafeId(inst.payloadId) || typeof inst.installedAt !== 'string'
          || !Array.isArray(inst.files)) {
          fail(`bundle ${bkey} unsafe instance ${ikey}`);
        }
        const scope = inst.scope as 'user' | 'repository';
        const storedRoot = inst.root as string;
        let root: string;
        let contextRoot: string | undefined;
        if (scope === 'user') {
          if (!isSafeAbsolutePath(storedRoot)) {
            fail(`bundle ${bkey} unsafe instance ${ikey}`);
          }
          root = storedRoot;
        } else {
          contextRoot = options.repositoryRoot;
          if (contextRoot === undefined || !isSafeAbsolutePath(contextRoot)) {
            fail(`instance ${ikey} has no repository context to resolve recorded paths`);
          }
          if (storedRoot !== '.' && !isSafeRelativePath(storedRoot)) {
            fail(`bundle ${bkey} unsafe instance ${ikey}`);
          }
          root = storedRoot === '.' ? contextRoot as string : path.join(contextRoot as string, storedRoot);
        }
        if (ikey !== lockfileInstanceKey(type, scope, storedRoot)) {
          fail(`instance key ${ikey} does not match its identity`);
        }
        const receiptId = runtimeReceiptId(type, scope, root, collection.sourceId, collection.manifestId, contextRoot);
        if (inst.installationId !== receiptId) {
          fail(`instance ${ikey} installationId does not match its identity`);
        }
        const instance = { type: type as TargetType, scope, root };
        const base = scope === 'user' ? root : (contextRoot as string);
        const outputs: RuntimeProjectionReceipt['outputs'] = {};
        const seen = new Set<string>();
        for (const f0 of inst.files as unknown[]) {
          const f = f0 as Record<string, unknown>;
          if (!isRec(f) || !isSafeRelativePath(f.path) || seen.has(f.path as string)
            || typeof f.checksum !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(f.checksum)) {
            fail(`instance ${ikey} unsafe file entry`);
          }
          seen.add(f.path as string);
          if (f.mode !== undefined && !isRuntimeMode(f.mode)) {
            fail(`instance ${ikey} file ${String(f.path)} bad mode`);
          }
          if (f.sourcePath !== undefined && !isSafeRelativePath(f.sourcePath)) {
            fail(`instance ${ikey} file ${String(f.path)} bad sourcePath`);
          }
          outputs[path.join(base as string, f.path as string)] = {
            sha256: f.checksum as string,
            ...(f.mode === undefined ? {} : { mode: f.mode as number }),
            ...(f.sourcePath === undefined ? {} : { sourcePath: f.sourcePath as string })
          };
        }
        receipts[receiptId] = {
          receiptId,
          instance,
          collection,
          payloadId: inst.payloadId as string,
          version: inst.version as string,
          outputs,
          installedAt: inst.installedAt as string,
          source,
          registryRef: { bundleId: bundle.bundleId as string, sourceType: source.type },
          ...(contextRoot === undefined ? {} : { contextRoot })
        };
      }
    }
  }
  return { receipts, sources };
}

/**
 * Read/inspect a legacy v2 lockfile: returns unresolved entries, never
 * guesses the previous tool. Not deletion-capable.
 */
export interface V2InspectionEntry {
  bundleId: string;
  version?: string;
  sourceId?: string;
  sourceType?: string;
  target: 'unknown';
  needsReinstall: true;
}
/**
 * Inspect an unknown-version lockfile document.
 * @param raw
 */
export function inspectLegacyV2(raw: unknown): { version: string; entries: V2InspectionEntry[] } {
  if (!isRec(raw)) {
    fail('v2 lockfile is not an object');
  }
  const version = (raw as Record<string, unknown>).version as string | undefined;
  if (version !== '2.0.0') {
    fail(`unsupported lockfile version ${String(version)}; only 2.0.0 can be inspected`);
  }
  const entries: V2InspectionEntry[] = [];
  const record = raw as Record<string, unknown>;
  if (!isRec(record.bundles)) {
    fail('v2 bundles must be an object');
  }
  const bundles = record.bundles as Record<string, unknown>;
  for (const [bundleId, b0] of Object.entries(bundles)) {
    const b = b0 as Record<string, unknown>;
    entries.push({
      bundleId,
      version: isRec(b) && typeof b.version === 'string' ? (b.version) : undefined,
      sourceId: isRec(b) && typeof b.sourceId === 'string' ? (b.sourceId) : undefined,
      sourceType: isRec(b) && typeof b.sourceType === 'string' ? (b.sourceType) : undefined,
      target: 'unknown',
      needsReinstall: true
    });
  }
  return { version: version as string, entries };
}
