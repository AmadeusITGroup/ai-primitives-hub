/**
 * FileTreeTargetWriter executes exact operations from the shared target planner.
 * Layout resolution remains here as a compatibility entry point for delivery
 * adapters; placement decisions belong to `createTargetWritePlan`.
 * @module writers/file-tree-writer
 */
import * as path from 'node:path';
import type {
  InstalledFileRecord,
  LayoutConfigLoader,
  ResourceTransformer,
  Target,
  TargetLayout,
  TargetWriteOperation,
  TargetWritePlan,
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  decodeUtf8Strict,
  installedChecksum,
  prunableSkillDirectories,
  verifyWrittenBytes,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts as builtInLayouts,
} from '@ai-primitives-hub/infra';
import {
  resolveLayoutFromLayers,
} from '../install/layout-resolver';

export type {
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';

export interface WriterFs {
  writeFile(p: string, contents: string): Promise<void>;
  writeFileBytes(p: string, bytes: Uint8Array): Promise<void>;
  readFileBytes(p: string): Promise<Uint8Array>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  remove(p: string): Promise<void>;
  removeEmptyDirectory?(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  realpath?(p: string): Promise<string>;
  lstat?(p: string): Promise<{ isSymbolicLink: boolean } | null>;
}

export interface FileTreeTargetWriterOptions {
  fs: WriterFs;
  env: Record<string, string | undefined>;
  transformer?: ResourceTransformer;
  managedFiles?: readonly InstalledFileRecord[];
}

export interface TargetRemoveResult {
  removed: string[];
  skipped: string[];
}

interface AttemptedWrite {
  record: InstalledFileRecord;
  previousBytes?: Uint8Array;
}

export type { TargetLayout } from '@ai-primitives-hub/core';

export const resolveLayout = (target: Target): TargetLayout => {
  const result = resolveLayoutFromLayers(target, [builtInLayouts]);
  if (result === null) {
    throw new Error(`No layout defined for target type "${target.type}"`);
  }
  return result;
};

export const resolveLayoutAsync = async (
  target: Target,
  loader: LayoutConfigLoader
): Promise<TargetLayout> => {
  const result = resolveLayoutFromLayers(target, await loader.load());
  if (result === null) {
    throw new Error(`No layout defined for target type "${target.type}"`);
  }
  return result;
};

export { expandPath } from '@ai-primitives-hub/core';

export class FileTreeTargetWriter implements TargetWriter {
  private readonly managedFiles: ReadonlyMap<string, InstalledFileRecord>;

  public constructor(private readonly opts: FileTreeTargetWriterOptions) {
    this.managedFiles = new Map(
      (opts.managedFiles ?? []).map((record) => [path.resolve(record.destinationPath), record])
    );
  }

  private async assertOverwriteAllowed(destinationPath: string): Promise<void> {
    if (!await this.opts.fs.exists(destinationPath)) {
      return;
    }
    const managed = this.managedFiles.get(path.resolve(destinationPath));
    if (managed === undefined) {
      throw new Error(`Refusing to overwrite unmanaged existing destination: ${destinationPath}`);
    }
    const existing = await this.opts.fs.readFileBytes(destinationPath);
    if (installedChecksum(existing) !== managed.installedChecksum) {
      throw new Error(`Refusing to overwrite modified managed destination: ${destinationPath}`);
    }
  }

  private async resolveRealPath(candidate: string): Promise<string> {
    if (this.opts.fs.realpath === undefined) {
      return path.resolve(candidate);
    }
    try {
      return await this.opts.fs.realpath(candidate);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new Error(`cannot resolve target path "${candidate}"`);
      }
      return path.join(await this.resolveRealPath(parent), path.basename(candidate));
    }
  }

  private async assertRealDestinationContained(
    destinationPath: string,
    destinationRelativePath: string
  ): Promise<void> {
    if (this.opts.fs.realpath === undefined || this.opts.fs.lstat === undefined) {
      return;
    }
    const segments = destinationRelativePath.replaceAll('\\', '/').split('/');
    const lexicalRoot = segments.reduce((ancestorPath) => path.dirname(ancestorPath), path.resolve(destinationPath));
    const realRoot = await this.resolveRealPath(lexicalRoot);
    let current = path.resolve(destinationPath);
    while (current !== lexicalRoot) {
      const info = await this.opts.fs.lstat(current);
      if (info?.isSymbolicLink === true) {
        let realCurrent: string;
        try {
          realCurrent = await this.opts.fs.realpath(current);
        } catch {
          throw new Error(`unsafe target destination "${destinationRelativePath}" contains a dangling symlink`);
        }
        if (realCurrent !== realRoot && !realCurrent.startsWith(`${realRoot}${path.sep}`)) {
          throw new Error(`unsafe target destination "${destinationRelativePath}" escapes target root`);
        }
      }
      current = path.dirname(current);
    }
    const realDestination = await this.resolveRealPath(destinationPath);
    if (realDestination !== realRoot && !realDestination.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`unsafe target destination "${destinationRelativePath}" escapes target root`);
    }
  }

  private async writeOperation(target: Target, operation: TargetWriteOperation): Promise<Uint8Array> {
    await this.opts.fs.mkdir(path.dirname(operation.destinationPath), { recursive: true });
    const text = operation.kind === 'skill' ? null : decodeUtf8Strict(operation.bytes);
    if (text === null) {
      await this.opts.fs.writeFileBytes(operation.destinationPath, operation.bytes);
      await verifyWrittenBytes(this.opts.fs, operation.destinationPath, operation.bytes);
      return operation.bytes;
    }

    let content = text;
    if (this.opts.transformer !== undefined) {
      try {
        content = this.opts.transformer.transform({
          target,
          filePath: operation.sourcePath,
          content
        }).content;
      } catch {
        // Preserve the original content when an optional transformation fails.
      }
    }
    const installedBytes = new TextEncoder().encode(content);
    await this.opts.fs.writeFile(operation.destinationPath, content);
    await verifyWrittenBytes(this.opts.fs, operation.destinationPath, installedBytes);
    return installedBytes;
  }

  private async pruneEmptySkillDirectories(files: readonly InstalledFileRecord[]): Promise<void> {
    if (this.opts.fs.removeEmptyDirectory === undefined) {
      return;
    }
    const removeEmptyDirectory = this.opts.fs.removeEmptyDirectory.bind(this.opts.fs);

    for (const directory of prunableSkillDirectories(files)) {
      try {
        await removeEmptyDirectory(directory);
      } catch {
        // A missing or non-empty directory must be preserved.
      }
    }
  }

  private async rollbackAttemptedWrites(attempted: readonly AttemptedWrite[]): Promise<void> {
    for (const { record, previousBytes } of attempted.toReversed()) {
      try {
        await (previousBytes === undefined ? this.opts.fs.remove(record.destinationPath) : this.opts.fs.writeFileBytes(record.destinationPath, previousBytes));
      } catch {
        // Preserve the original write error when rollback is best effort.
      }
    }
    await this.pruneEmptySkillDirectories(
      attempted.filter(({ previousBytes }) => previousBytes === undefined).map(({ record }) => record)
    );
  }

  public async preflight(plan: TargetWritePlan): Promise<void> {
    for (const operation of plan.operations) {
      const normalizedRelativePath = operation.destinationRelativePath.replaceAll('\\', '/');
      if (path.posix.isAbsolute(normalizedRelativePath)
        || path.win32.isAbsolute(normalizedRelativePath)
        || normalizedRelativePath.split('/').includes('..')) {
        throw new Error(`unsafe target destination "${operation.destinationRelativePath}"`);
      }
      await this.assertRealDestinationContained(
        operation.destinationPath,
        operation.destinationRelativePath
      );
      await this.assertOverwriteAllowed(operation.destinationPath);
    }
  }

  public async write(plan: TargetWritePlan): Promise<TargetWriteResult> {
    const attempted: AttemptedWrite[] = [];
    let pending: AttemptedWrite | undefined;
    try {
      for (const operation of plan.operations) {
        await this.assertRealDestinationContained(
          operation.destinationPath,
          operation.destinationRelativePath
        );
        await this.assertOverwriteAllowed(operation.destinationPath);
        const previousBytes = await this.opts.fs.exists(operation.destinationPath)
          ? await this.opts.fs.readFileBytes(operation.destinationPath)
          : undefined;
        pending = {
          record: {
            itemId: operation.itemId,
            kind: operation.kind,
            sourcePath: operation.sourcePath,
            destinationPath: operation.destinationPath,
            destinationRelativePath: operation.destinationRelativePath,
            installedChecksum: operation.sourceChecksum
          },
          previousBytes
        };
        const installedBytes = await this.writeOperation(plan.target, operation);
        pending.record.installedChecksum = installedChecksum(installedBytes);
        attempted.push(pending);
        pending = undefined;
      }
    } catch (cause) {
      await this.rollbackAttemptedWrites(pending === undefined ? attempted : [...attempted, pending]);
      throw cause;
    }
    return { installed: attempted.map(({ record }) => record) };
  }

  public async rollback(installed: readonly InstalledFileRecord[]): Promise<void> {
    for (const file of installed) {
      try {
        await this.opts.fs.remove(file.destinationPath);
      } catch {
        // Preserve the original write error when rollback is best effort.
      }
    }
    await this.pruneEmptySkillDirectories(installed);
  }

  public async remove(files: readonly InstalledFileRecord[]): Promise<void> {
    for (const file of files) {
      await this.assertRealDestinationContained(file.destinationPath, file.destinationRelativePath);
      await this.opts.fs.remove(file.destinationPath);
    }
    await this.pruneEmptySkillDirectories(files);
  }
}
