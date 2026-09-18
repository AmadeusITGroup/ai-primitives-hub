/**
 * Cross-executor parity: `UserScopeService.executeTargetPlan` vs
 * `FileTreeTargetWriter`.
 *
 * Two executors run the same `TargetWritePlan` today — the shared
 * `FileTreeTargetWriter` (CLI + extension repository scope) and the extension's
 * user-scope executor, which additionally prefers symlinks, copies under WSL,
 * skips unmanaged files instead of failing, and prompts before replacing a
 * skill. Those differences are deliberate delivery-layer policy, but everything
 * that ends up in an `InstalledFileRecord` must be identical, because both feed
 * the same lockfile/state records, update diffing and uninstall pipeline.
 *
 * This suite pins that contract: given one plan, both executors must produce the
 * same destinations, the same item ids and kinds, and the same installed
 * checksums, and must place the same files on disk.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTargetWritePlan,
  FileTreeTargetWriter,
  resolveLayout,
} from '@ai-primitives-hub/app';
import type {
  WriterFs,
} from '@ai-primitives-hub/app';
import {
  createBundleInstallPlan,
  type InstalledFileRecord,
  type Target,
  type TargetWritePlan,
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  UserScopeService,
} from '../../src/services/user-scope-service';
import {
  createFoursightBundle,
} from '../fixtures/foursight-bundle';

/** `WriterFs` adapter over Node's `fs`, mirroring the repository-scope adapter. */
class NodeWriterFs implements WriterFs {
  public async writeFile(p: string, contents: string): Promise<void> {
    await fs.promises.writeFile(p, contents, 'utf8');
  }

  public async writeFileBytes(p: string, bytes: Uint8Array): Promise<void> {
    await fs.promises.writeFile(p, bytes);
  }

  public async readFileBytes(p: string): Promise<Uint8Array> {
    return fs.promises.readFile(p);
  }

  public async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
    await fs.promises.mkdir(p, opts);
  }

  public async remove(p: string): Promise<void> {
    await fs.promises.rm(p, { recursive: true, force: true });
  }

  public async removeEmptyDirectory(p: string): Promise<void> {
    await fs.promises.rmdir(p);
  }

  public exists(p: string): Promise<boolean> {
    return Promise.resolve(fs.existsSync(p));
  }

  public realpath(p: string): Promise<string> {
    return fs.promises.realpath(p);
  }

  public async lstat(p: string): Promise<{ isSymbolicLink: boolean } | null> {
    try {
      const stats = await fs.promises.lstat(p);
      return { isSymbolicLink: stats.isSymbolicLink() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}

suite('TargetWritePlan executor parity (user scope vs FileTreeTargetWriter)', () => {
  let tempDir: string;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-parity-'));
  });

  teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const writeBundleSource = (bundlePath: string, files: ReadonlyMap<string, Uint8Array>): void => {
    for (const [entryPath, bytes] of files) {
      if (entryPath === 'deployment-manifest.yml') {
        continue;
      }
      const target = path.join(bundlePath, entryPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(bytes));
    }
  };

  /**
   * Build a plan whose destinations sit under `home`, so each executor can be
   * pointed at its own isolated home directory.
   * @param files - Bundle files.
   * @param home - Home directory the plan resolves against.
   */
  const planFor = (files: ReadonlyMap<string, Uint8Array>, home: string): TargetWritePlan => {
    const target: Target = { name: 'vscode', type: 'vscode', scope: 'user' };
    return createTargetWritePlan(
      createBundleInstallPlan(files, validateManifest(files, {})),
      target,
      resolveLayout(target),
      { ...process.env, HOME: home }
    );
  };

  /**
   * Compare only the fields both executors are contractually required to agree on.
   * @param records
   * @param home
   */
  const comparable = (records: readonly InstalledFileRecord[], home: string) =>
    records
      .map((record) => ({
        itemId: record.itemId,
        kind: record.kind,
        sourcePath: record.sourcePath,
        destinationRelativePath: record.destinationRelativePath,
        destination: path.relative(home, record.destinationPath).split(path.sep).join('/'),
        installedChecksum: record.installedChecksum
      }))
      .toSorted((left, right) => left.destination.localeCompare(right.destination));

  const filesOnDisk = (root: string): string[] => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else {
          found.push(path.relative(root, entryPath).split(path.sep).join('/'));
        }
      }
    };
    walk(root);
    return found.toSorted();
  };

  test('both executors install identical records and files for the same plan', async () => {
    const bundleFiles = createFoursightBundle();
    const bundlePath = path.join(tempDir, 'bundle');
    writeBundleSource(bundlePath, bundleFiles);

    const userHome = path.join(tempDir, 'user-scope-home');
    const writerHome = path.join(tempDir, 'file-tree-home');
    fs.mkdirSync(userHome, { recursive: true });
    fs.mkdirSync(writerHome, { recursive: true });

    const mockContext: any = {
      globalStorageUri: { fsPath: path.join(tempDir, 'globalStorage') },
      extensionPath: __dirname,
      subscriptions: []
    };
    const service = new UserScopeService(mockContext, userHome, 'vscode');
    const userResult = await service.syncBundle('foursight-pr-review', bundlePath, {
      targetPlan: planFor(bundleFiles, userHome)
    });

    const writer = new FileTreeTargetWriter({ fs: new NodeWriterFs(), env: process.env });
    const writerResult = await writer.write(planFor(bundleFiles, writerHome));

    assert.ok(userResult.installed.length > 0, 'The fixture should install at least one file');
    assert.deepStrictEqual(
      comparable(userResult.installed, userHome),
      comparable(writerResult.installed, writerHome),
      'Both executors must produce identical installed records for the same plan'
    );
    assert.deepStrictEqual(
      filesOnDisk(userHome),
      filesOnDisk(writerHome),
      'Both executors must place the same files at the same destinations'
    );
  });

  test('both executors remove the same files and prune the same skill directories', async () => {
    const bundleFiles = createFoursightBundle();
    const bundlePath = path.join(tempDir, 'bundle');
    writeBundleSource(bundlePath, bundleFiles);

    const userHome = path.join(tempDir, 'user-scope-home');
    const writerHome = path.join(tempDir, 'file-tree-home');
    fs.mkdirSync(userHome, { recursive: true });
    fs.mkdirSync(writerHome, { recursive: true });

    const mockContext: any = {
      globalStorageUri: { fsPath: path.join(tempDir, 'globalStorage') },
      extensionPath: __dirname,
      subscriptions: []
    };
    const service = new UserScopeService(mockContext, userHome, 'vscode');
    const userInstalled = (await service.syncBundle('foursight-pr-review', bundlePath, {
      targetPlan: planFor(bundleFiles, userHome)
    })).installed;

    const writer = new FileTreeTargetWriter({ fs: new NodeWriterFs(), env: process.env });
    const writerInstalled = (await writer.write(planFor(bundleFiles, writerHome))).installed;

    await service.unsyncBundle('foursight-pr-review', { installedFiles: userInstalled });
    await writer.remove(writerInstalled);

    assert.deepStrictEqual(filesOnDisk(userHome), [], 'User scope should remove every installed file');
    assert.deepStrictEqual(filesOnDisk(writerHome), [], 'FileTreeTargetWriter should remove every installed file');
    assert.strictEqual(
      fs.existsSync(path.join(userHome, '.copilot', 'skills', 'foursight-code-review')),
      fs.existsSync(path.join(writerHome, '.copilot', 'skills', 'foursight-code-review')),
      'Both executors must agree on whether the emptied skill directory is pruned'
    );
  });
});
