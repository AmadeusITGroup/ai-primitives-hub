import {
  UnsafeRepositoryPathError,
} from './repository-path';

export interface FileWriteJournalFs {
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>;
  lstat?(path: string): Promise<{ isSymbolicLink: boolean }>;
  remove(path: string): Promise<void>;
}

interface JournalEntry {
  original: Uint8Array | null;
  intended: Uint8Array;
  completed: boolean;
  failedState: Uint8Array | null | undefined;
  failedStateKnown: boolean;
}

interface CapturedState {
  known: boolean;
  bytes?: Uint8Array | null;
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class FileWriteJournal {
  private readonly entries = new Map<string, JournalEntry>();

  public constructor(private readonly fs: FileWriteJournalFs) {}

  private async readOriginal(path: string): Promise<Uint8Array | null> {
    if (this.fs.lstat === undefined) {
      throw new UnsafeRepositoryPathError(path, 'cannot be checked before installation');
    }
    let finalPath: { isSymbolicLink: boolean };
    try {
      finalPath = await this.fs.lstat(path);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw new UnsafeRepositoryPathError(path, 'cannot be checked before installation');
    }
    if (finalPath.isSymbolicLink) {
      throw new UnsafeRepositoryPathError(path, 'is a symlink and cannot be written safely');
    }
    try {
      return (await this.fs.readFileBytes(path)).slice();
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  private async captureFailedState(path: string): Promise<CapturedState> {
    if (this.fs.lstat === undefined) {
      return { known: false };
    }
    try {
      if ((await this.fs.lstat(path)).isSymbolicLink) {
        return { known: false };
      }
      return { known: true, bytes: (await this.fs.readFileBytes(path)).slice() };
    } catch (error) {
      return isMissing(error) ? { known: true, bytes: null } : { known: false };
    }
  }

  public async write(
    path: string,
    intendedBytes: Uint8Array,
    actualWriteAndVerify: () => Promise<void>
  ): Promise<void> {
    const existing = this.entries.get(path);
    const original = existing === undefined ? await this.readOriginal(path) : existing.original;
    const entry: JournalEntry = existing ?? {
      original,
      intended: intendedBytes.slice(),
      completed: false,
      failedState: undefined,
      failedStateKnown: false
    };
    entry.intended = intendedBytes.slice();
    entry.completed = false;
    entry.failedState = undefined;
    entry.failedStateKnown = false;
    this.entries.set(path, entry);

    try {
      await actualWriteAndVerify();
      entry.completed = true;
    } catch (failure) {
      const state = await this.captureFailedState(path);
      entry.failedStateKnown = state.known;
      entry.failedState = state.bytes;
      throw failure;
    }
  }

  public getPaths(): string[] {
    return [...this.entries.keys()];
  }

  public async rollback(paths: readonly string[] = [...this.entries.keys()]): Promise<void> {
    const errors: unknown[] = [];
    for (const path of [...paths].reverse()) {
      const entry = this.entries.get(path);
      if (entry === undefined) {
        continue;
      }

      let current: Uint8Array | null;
      try {
        if (this.fs.lstat === undefined) {
          throw new UnsafeRepositoryPathError(path, 'cannot be checked before rollback');
        }
        if ((await this.fs.lstat(path)).isSymbolicLink) {
          errors.push(new UnsafeRepositoryPathError(path, 'became a symlink before rollback'));
          continue;
        }
        try {
          current = await this.fs.readFileBytes(path);
        } catch (error) {
          if (!isMissing(error)) {
            throw error;
          }
          current = null;
        }
      } catch (error) {
        if (isMissing(error)) {
          current = null;
        } else {
          errors.push(error);
          continue;
        }
      }

      if (!entry.completed && !entry.failedStateKnown) {
        errors.push(new Error(`Cannot establish whether ${path} changed after a failed write`));
        continue;
      }
      const expected = entry.completed ? entry.intended : entry.failedState;
      const unchanged = expected === null
        ? current === null
        : (expected !== undefined && current !== null && equalBytes(current, expected));
      if (!unchanged) {
        continue;
      }

      try {
        if (entry.original === null) {
          if (current !== null) {
            await this.fs.remove(path);
          }
        } else {
          await this.fs.writeFileBytes(path, entry.original);
        }
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `File write rollback was incomplete (${errors.map(String).join('; ')})`);
    }
  }
}
