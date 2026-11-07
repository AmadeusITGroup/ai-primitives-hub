/** Helpers for tests that read install records from a real temp git root, or the user record from a temp home. */
import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  emptyLockfile,
  getLockfilePathForMode,
  type Lockfile,
  type LockfileFs,
  type RecordSourceInput,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
} from '@ai-primitives-hub/app';
import {
  RECORD_SCHEMA_URL,
} from '@ai-primitives-hub/core';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type {
  ExtensionRecordAdapter,
} from '../../src/services/extension-record-adapter';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import type {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import type {
  Bundle,
  InstalledBundle,
  RegistrySource,
  RepositoryCommitMode,
} from '../../src/types/registry';

/** Committed and local-only record file names. */
export {
  LOCAL_RECORD_FILE_NAME as LOCAL_RECORD_FILE,
  RECORD_FILE_NAME as RECORD_FILE,
} from '@ai-primitives-hub/core';

/**
 * Minimal `ExtensionContext` for constructing a `RegistryManager`.
 * @param sandbox - Sinon sandbox owning the stubs.
 */
export const createMockContext = (sandbox: sinon.SinonSandbox): vscode.ExtensionContext => ({
  globalState: { get: sandbox.stub(), update: sandbox.stub().resolves(), keys: sandbox.stub().returns([]), setKeysForSync: sandbox.stub() },
  workspaceState: { get: sandbox.stub(), update: sandbox.stub().resolves(), keys: sandbox.stub().returns([]), setKeysForSync: sandbox.stub() },
  subscriptions: [],
  extensionPath: '/mock/path',
  extensionUri: vscode.Uri.file('/mock/path'),
  storageUri: vscode.Uri.file('/mock/storage'),
  globalStorageUri: vscode.Uri.file('/mock/global'),
  asAbsolutePath: (p: string) => `/mock/path/${p}`
}) as unknown as vscode.ExtensionContext;

/**
 * Mark a folder as a git root.
 * @param root - Folder to mark.
 */
export const initGitRoot = (root: string): void => {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
};

/** Bundles to write: bundle id → tool → version, install time and one recorded file. */
export type RecordSpec = Record<string, Record<string, { version: string; installedAt: string; file: string }>>;

/** `LockfileFs` over Node's filesystem, for writing old-file fixtures. */
export const nodeLockfileFs: LockfileFs = {
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  writeFile: (file, contents) => fs.promises.writeFile(file, contents),
  exists: (file) => Promise.resolve(fs.existsSync(file)),
  mkdir: async (dir, options) => {
    await fs.promises.mkdir(dir, options);
  }
};

/** One bundle entry {@link writeOldLockfile} writes. */
export interface OldLockfileEntry {
  version: string;
  /** Paths the entry lists, each with a zero checksum; none by default. */
  files?: readonly string[];
  /** The lockfile source's id by default. */
  sourceId?: string;
  /** The lockfile source's type by default. */
  sourceType?: string;
}

/** Source {@link writeOldLockfile} writes by default. */
export const OLD_LOCKFILE_SOURCE = { id: 'old-source', type: 'local', url: '/old/source' };

/**
 * Write an old 2.0.0 lockfile (a repository `prompt-registry.*.json` or the
 * CLI's old user lockfile) through app's `writeLockfile`, creating its folder.
 * Every entry is installed at `2026-10-01T10:00:00.000Z`; the files it lists
 * are not written (migration takes checksums from disk again).
 * @param file - Absolute lockfile path.
 * @param bundles - Bundle id → entry.
 * @param source - The lockfile's one source; {@link OLD_LOCKFILE_SOURCE} by default.
 */
export const writeOldLockfile = async (
  file: string,
  bundles: Record<string, OldLockfileEntry>,
  source: { id: string; type: string; url: string } = OLD_LOCKFILE_SOURCE
): Promise<void> => {
  let lock = emptyLockfile('prompt-registry@2.0.0');
  for (const [bundleId, entry] of Object.entries(bundles)) {
    lock = upsertBundleEntry(lock, bundleId, {
      version: entry.version,
      sourceId: entry.sourceId ?? source.id,
      sourceType: entry.sourceType ?? source.type,
      installedAt: '2026-10-01T10:00:00.000Z',
      files: (entry.files ?? []).map((recorded) => ({ path: recorded, checksum: '0'.repeat(64) }))
    });
  }
  lock = upsertSource(lock, source.id, { type: source.type, url: source.url });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeLockfile(file, lock, nodeLockfileFs);
};

/** What {@link recordProfileInstall} writes. */
export interface ProfileInstallOptions {
  bundleId: string;
  version: string;
  sourceId: string;
  /** Bundle cache contents: bundle-relative path → content, the deployment manifest included. */
  cache: Record<string, string>;
  /** Bundle-relative file the profile synced, a key of `cache`. */
  syncedFile: string;
  /** Absolute user file it was synced to. */
  userFile: string;
  /** Copy the file (the symlink fallback) instead of linking to the cache. */
  copy?: boolean;
}

/**
 * A profile's RegistryStorage user install from before the user record: its
 * bundle cache, the synced user file (a symlink into the cache, or a copy)
 * and the RegistryStorage entry with scope `user` and source type `local`.
 * @param storage - The manager's RegistryStorage.
 * @param cacheDir - Absolute bundle cache folder (`globalStorage/bundles/<id>`).
 * @param options - Bundle, version, source, cache contents and the synced file.
 */
export const recordProfileInstall = async (storage: RegistryStorage, cacheDir: string, options: ProfileInstallOptions): Promise<void> => {
  for (const [file, content] of Object.entries(options.cache)) {
    fs.mkdirSync(path.dirname(path.join(cacheDir, file)), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, file), content);
  }
  const cached = path.join(cacheDir, ...options.syncedFile.split('/'));
  fs.mkdirSync(path.dirname(options.userFile), { recursive: true });
  if (options.copy === true) {
    fs.copyFileSync(cached, options.userFile);
  } else {
    fs.symlinkSync(cached, options.userFile, 'file');
  }
  await storage.recordInstallation({
    bundleId: options.bundleId, version: options.version, installedAt: '2026-10-01T10:00:00.000Z', scope: 'user', installPath: cacheDir,
    manifest: {} as InstalledBundle['manifest'], sourceId: options.sourceId, sourceType: 'local'
  });
};

/** Source {@link recordEntry} and {@link writeOldEntry} record by default. */
export const ACME_SOURCE: RecordSourceInput = { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools' };

/** What {@link recordEntry} installs. */
export interface RecordEntryOptions {
  bundleId: string;
  /** Tool key; the adapter's host tool by default. */
  tool?: string;
  /** Root-relative files to write and record. */
  files: readonly string[];
  /** Record file; the committed one by default. */
  commitMode?: RepositoryCommitMode;
  /** Source to record; {@link ACME_SOURCE} by default. */
  source?: RecordSourceInput;
  /** Content of each file written; `# <bundleId>\n` by default. */
  content?: string;
  /** Leave a file that already exists as it is. */
  keepExisting?: boolean;
}

/**
 * Write files and record them for a tool, as that tool's install would.
 * @param adapter - Record adapter of the extension under test.
 * @param root - Git root.
 * @param options - Bundle, tool, files and record file.
 */
export const recordEntry = async (adapter: ExtensionRecordAdapter, root: string, options: RecordEntryOptions): Promise<void> => {
  for (const relative of options.files) {
    const absolute = path.join(root, ...relative.split('/'));
    if (options.keepExisting === true && fs.existsSync(absolute)) {
      continue;
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, options.content ?? `# ${options.bundleId}\n`);
  }
  const [committed, localOnly] = await adapter.locations(root);
  const source = options.source ?? ACME_SOURCE;
  await adapter.service.recordInstall({
    location: options.commitMode === 'local-only' ? localOnly : committed,
    bundleId: options.bundleId,
    version: '1.0.0',
    tool: options.tool ?? adapter.hostTool,
    source,
    sourceType: source.type,
    writtenPaths: options.files.map((relative) => path.join(root, ...relative.split('/'))),
    syncSiblings: false
  });
};

/** What {@link writeOldEntry} writes. */
export interface OldEntryOptions {
  /** Root-relative path → content written now; the bare SHA-256 of `recorded`, else of the content, is recorded. */
  files?: Record<string, string | { content: string; recorded: string }>;
  /** Root-relative paths recorded but not written, with a zero checksum. */
  missing?: readonly string[];
  /** Source the entry names, also written under `sources`; {@link ACME_SOURCE} by default. */
  source?: { id: string; type: string; url: string };
  /** `hubs` of the old file. */
  hubs?: Lockfile['hubs'];
  /** Entry version; `1.0.0` by default. */
  version?: string;
}

/**
 * Write the committed old `prompt-registry.lock.json` with one bundle entry and its files.
 * @param root - Workspace folder.
 * @param bundleId - Bundle id.
 * @param options - Files, source, hubs and version.
 */
export const writeOldEntry = async (root: string, bundleId: string, options: OldEntryOptions = {}): Promise<void> => {
  const files = Object.entries(options.files ?? {}).map(([relative, given]) => {
    const { content, recorded } = typeof given === 'string' ? { content: given, recorded: given } : given;
    const absolute = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return { path: relative, checksum: createHash('sha256').update(recorded).digest('hex') };
  });
  const source = options.source ?? { id: ACME_SOURCE.sourceId, type: ACME_SOURCE.type, url: ACME_SOURCE.url };
  const lock = upsertSource(upsertBundleEntry(emptyLockfile('prompt-registry@1.0.0'), bundleId, {
    version: options.version ?? '1.0.0',
    sourceId: source.id,
    sourceType: source.type,
    installedAt: '2026-10-28T10:00:00.000Z',
    files: [...files, ...(options.missing ?? []).map((relative) => ({ path: relative, checksum: '0'.repeat(64) }))]
  }), source.id, { type: source.type, url: source.url });
  if (options.hubs !== undefined) {
    lock.hubs = options.hubs;
  }
  await writeLockfile(getLockfilePathForMode(root, 'commit'), lock, nodeLockfileFs);
};

/**
 * Write an install record and the files it lists.
 * @param root - Git root.
 * @param fileName - {@link RECORD_FILE} or {@link LOCAL_RECORD_FILE}.
 * @param spec - Bundles to record.
 */
export const writeInstallRecord = (root: string, fileName: string, spec: RecordSpec): void => {
  const bundles = Object.fromEntries(Object.entries(spec).map(([bundleId, tools]) => [bundleId, {
    tools: Object.fromEntries(Object.entries(tools).map(([tool, entry]) => {
      const absolute = path.join(root, ...entry.file.split('/'));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, `# ${bundleId} ${tool}\n`);
      return [tool, {
        version: entry.version,
        sourceId: 'acme-github',
        sourceType: 'github',
        installedAt: entry.installedAt,
        files: [{ path: entry.file, checksum: `sha256:${'0'.repeat(64)}` }]
      }];
    }))
  }]));
  fs.writeFileSync(path.join(root, fileName), `${JSON.stringify({
    $schema: RECORD_SCHEMA_URL,
    version: '3.0.0',
    level: 'repository',
    generatedAt: '2026-10-28T10:00:00.000Z',
    generatedBy: 'ai-primitives-hub-cli@0.3.0',
    bundles,
    sources: { 'acme-github': { type: 'github', url: 'https://github.com/acme/tools' } }
  }, null, 2)}\n`);
};

/**
 * Set process environment variables for one test, e.g. a temp `HOME`.
 * @param values - Variables to set.
 * @returns Restores the previous values.
 */
export const overrideEnv = (values: Record<string, string>): (() => void) => {
  const saved = Object.entries(values).map(([key]) => [key, process.env[key]] as const);
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  };
};

/**
 * A `Bundle` as a source lists it, with empty catalog fields unless given.
 * @param fields - Id and version, and any field to set.
 */
export const testBundle = (fields: Partial<Bundle> & Pick<Bundle, 'id' | 'version'>): Bundle => ({
  name: fields.id, description: '', author: '', sourceId: '',
  environments: [], tags: [], lastUpdated: '', size: '', dependencies: [], license: '', manifestUrl: '', downloadUrl: '',
  ...fields
});

/** A `RegistryManager` on a temp home with one configured source, from {@link setupUserRecordManager}. */
export interface UserRecordManager {
  manager: RegistryManager;
  /** Its real `RegistryStorage`, in `globalStorage`. */
  storage: RegistryStorage;
  /** `globalStorageUri`, under `tempRoot`. */
  globalStorage: string;
  /** The `vscode.window.showErrorMessage` stub. */
  showError: sinon.SinonStub;
  /** Restore the sandbox and the environment, drop the manager and remove `tempRoot`. */
  dispose: () => void;
}

/**
 * A fresh `RegistryManager` whose user installs go to a temp home, with one
 * configured source and stubbed `vscode.window` messages.
 * @param sandbox - Sinon sandbox owning the stubs.
 * @param options - Setup options.
 * @param options.tempRoot - Temp folder; removed by `dispose`.
 * @param options.env - Environment variables to set until `dispose`.
 * @param options.source - The configured source.
 */
export const setupUserRecordManager = async (
  sandbox: sinon.SinonSandbox,
  options: { tempRoot: string; env: Record<string, string>; source: RegistrySource }
): Promise<UserRecordManager> => {
  const restoreEnv = overrideEnv(options.env);
  // `User/globalStorage/<id>`, so the user MCP config derived from it stays in the temp folder.
  const globalStorage = path.join(options.tempRoot, 'User', 'globalStorage', 'acme.extension');
  (RegistryManager as any).instance = undefined;
  const manager = RegistryManager.getInstance({ ...createMockContext(sandbox), globalStorageUri: vscode.Uri.file(globalStorage) });
  const storage = manager.getStorage();
  await storage.initialize();
  await storage.addSource(options.source);
  const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
  sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
  sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
  return {
    manager,
    storage,
    globalStorage,
    showError,
    dispose: () => {
      sandbox.restore();
      restoreEnv();
      (RegistryManager as any).instance = undefined;
      fs.rmSync(options.tempRoot, { recursive: true, force: true });
    }
  };
};

/**
 * Whether anything is at a path, a dangling symlink included.
 * @param file - Absolute path.
 */
export const isOnDisk = (file: string): boolean => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;

/**
 * Snapshot every file under a folder (path → content), for "nothing changed on disk" checks.
 * @param root - Folder to snapshot.
 */
export const snapshotTree = (root: string): Map<string, string> => {
  const snapshot = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        snapshot.set(path.relative(root, absolute).split(path.sep).join('/'), fs.readFileSync(absolute, 'utf8'));
      }
    }
  };
  walk(root);
  return snapshot;
};
