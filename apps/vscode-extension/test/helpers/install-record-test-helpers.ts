/**
 * Helpers for tests that read 3.0.0 install records
 * (`ai-primitives-hub.lock.json` / `ai-primitives-hub.local.lock.json`).
 *
 * Records are written as plain JSON files in a real temp folder with a git
 * root marker, so the extension's listing reads them through the real
 * `RecordStore` and `NodeRecordFs`.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  createMockFileEntry,
  LockfileBuilder,
} from './lockfile-test-helpers';

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
 * Write a prompt-registry lockfile and the files it lists.
 * @param root - Repository root.
 * @param fileName - `prompt-registry.lock.json` or `prompt-registry.local.lock.json`.
 * @param bundles - Bundle id → version.
 */
export const writeOldLockfile = (root: string, fileName: string, bundles: Record<string, string>): void => {
  const builder = LockfileBuilder.create()
    .withSource('old-source', 'github', 'https://github.com/old/repo');
  for (const [bundleId, version] of Object.entries(bundles)) {
    const file = createMockFileEntry(`.github/prompts/${bundleId}.old.prompt.md`);
    fs.mkdirSync(path.join(root, '.github', 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(root, file.path), 'old content');
    builder.withBundle(bundleId, version, 'old-source', { sourceType: 'github', files: [file] });
  }
  fs.writeFileSync(path.join(root, fileName), JSON.stringify(builder.build(), null, 2));
};

/** Committed install record file name. */
export const RECORD_FILE = 'ai-primitives-hub.lock.json';
/** Local-only install record file name. */
export const LOCAL_RECORD_FILE = 'ai-primitives-hub.local.lock.json';

/** One tool entry to write. */
export interface ToolEntrySpec {
  version: string;
  installedAt: string;
  /** Root-relative paths; written to disk unless listed in `missing`. */
  files: string[];
  /** Root-relative paths recorded but not created on disk. */
  missing?: string[];
  sourceId?: string;
  sourceType?: string;
}

/** Bundles to write: bundle id → tool → entry. */
export type RecordSpec = Record<string, Record<string, ToolEntrySpec>>;

/**
 * Mark a folder as a git root (BR2.1).
 * @param root - Folder to mark.
 */
export const initGitRoot = (root: string): void => {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
};

const sha256 = (content: string): string => `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;

/**
 * Write an install record and the files it lists.
 * @param root - Git root.
 * @param fileName - {@link RECORD_FILE} or {@link LOCAL_RECORD_FILE}.
 * @param spec - Bundles to record.
 * @returns Absolute path of the record file.
 */
export const writeInstallRecord = (root: string, fileName: string, spec: RecordSpec): string => {
  const bundles: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  for (const [bundleId, tools] of Object.entries(spec)) {
    const toolEntries: Record<string, unknown> = {};
    for (const [tool, entry] of Object.entries(tools)) {
      const sourceId = entry.sourceId ?? 'acme-github';
      sources[sourceId] = { type: entry.sourceType ?? 'github', url: `https://github.com/acme/${sourceId}` };
      const files = [...entry.files, ...(entry.missing ?? [])].toSorted().map((installedPath) => {
        const content = `# ${bundleId} ${tool} ${installedPath}\n`;
        if (!(entry.missing ?? []).includes(installedPath)) {
          const absolute = path.join(root, ...installedPath.split('/'));
          fs.mkdirSync(path.dirname(absolute), { recursive: true });
          fs.writeFileSync(absolute, content);
        }
        return { installedPath, checksum: sha256(content) };
      });
      toolEntries[tool] = {
        version: entry.version,
        sourceId,
        sourceType: entry.sourceType ?? 'github',
        installedAt: entry.installedAt,
        files
      };
    }
    bundles[bundleId] = { tools: toolEntries };
  }
  const record = {
    $schema: 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json',
    version: '3.0.0',
    level: 'repository',
    generatedAt: '2026-10-28T10:00:00.000Z',
    generatedBy: 'ai-primitives-hub-cli@0.3.0',
    bundles,
    sources
  };
  const recordPath = path.join(root, fileName);
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return recordPath;
};

/**
 * Snapshot every file under a folder (path → content), for "nothing changed on disk" checks.
 * @param root - Folder to snapshot.
 * @returns Sorted map of root-relative paths to contents.
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
