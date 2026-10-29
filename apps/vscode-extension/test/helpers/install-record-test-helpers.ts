/**
 * Helpers for tests that read 3.0.0 install records
 * (`ai-primitives-hub.lock.json` / `ai-primitives-hub.local.lock.json`)
 * from a real temp git root.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  createMockFileEntry,
  LockfileBuilder,
} from './lockfile-test-helpers';

/** Committed install record file name. */
export const RECORD_FILE = 'ai-primitives-hub.lock.json';
/** Local-only install record file name. */
export const LOCAL_RECORD_FILE = 'ai-primitives-hub.local.lock.json';

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
    $schema: 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json',
    version: '3.0.0',
    level: 'repository',
    generatedAt: '2026-10-28T10:00:00.000Z',
    generatedBy: 'ai-primitives-hub-cli@0.3.0',
    bundles,
    sources: { 'acme-github': { type: 'github', url: 'https://github.com/acme/tools' } }
  }, null, 2)}\n`);
};

/**
 * Snapshot every file under a folder (path → content), for "nothing changed on disk" checks.
 * @param root - Folder to snapshot.
 * @returns Map of root-relative paths to contents, in walk order.
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
