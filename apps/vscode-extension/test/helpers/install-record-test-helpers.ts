/** Helpers for tests that read install records from a real temp git root. */
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
import type {
  RepositoryCommitMode,
} from '../../src/types/registry';
import {
  createMockFileEntry,
  LockfileBuilder,
} from './lockfile-test-helpers';

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

/**
 * Write a prompt-registry lockfile and the files it lists.
 * @param root - Repository root.
 * @param fileName - `prompt-registry.lock.json` or `prompt-registry.local.lock.json`.
 * @param bundles - Bundle id → version.
 */
export const writeOldLockfile = (root: string, fileName: string, bundles: Record<string, string>): void => {
  const builder = LockfileBuilder.create().withSource('old-source', 'github', 'https://github.com/old/repo');
  for (const [bundleId, version] of Object.entries(bundles)) {
    const file = createMockFileEntry(`.github/prompts/${bundleId}.old.prompt.md`);
    fs.mkdirSync(path.join(root, '.github', 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(root, file.path), 'old content');
    builder.withBundle(bundleId, version, 'old-source', { sourceType: 'github', files: [file] });
  }
  fs.writeFileSync(path.join(root, fileName), JSON.stringify(builder.build(), null, 2));
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
 * Set process environment variables for one test, e.g. a temp `HOME` so
 * user-scope installs never write the real home folder.
 * @param values - Variables to set.
 * @returns Restores the previous values (unset ones are removed again).
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
