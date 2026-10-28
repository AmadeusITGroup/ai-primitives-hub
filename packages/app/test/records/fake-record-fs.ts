/**
 * In-memory `RecordFs` for install-record error paths that a real disk cannot
 * produce on demand (rename failure, temp collision, write failure).
 *
 * Entries are files, folders or symlinks keyed by absolute path; `realpath`
 * follows symlinks segment by segment. Set `renameError` or `writeError` to
 * make the next calls fail; `calls` lists every mutating call in order.
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import type {
  RecordFileStat,
  RecordFs,
} from '@ai-primitives-hub/core';

type Entry =
  | { kind: 'file'; data: string }
  | { kind: 'directory' }
  | { kind: 'symlink'; target: string };

type Entries = Map<string, Entry>;

const MAX_LINK_DEPTH = 40;

const errnoError = (code: string, message: string): NodeJS.ErrnoException => {
  const error = new Error(`${code}: ${message}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

/**
 * Follow symlinks in every segment, throwing `ENOENT` for a missing one.
 * @param entries - Filesystem entries.
 * @param file - Path to resolve.
 * @param depth - Links followed so far.
 */
const resolveAll = (entries: Entries, file: string, depth = 0): string => {
  if (depth > MAX_LINK_DEPTH) {
    throw errnoError('ELOOP', file);
  }
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  const base = parent === absolute ? absolute : path.join(resolveAll(entries, parent, depth + 1), path.basename(absolute));
  const entry = entries.get(base);
  if (entry === undefined) {
    throw errnoError('ENOENT', base);
  }
  return entry.kind === 'symlink' ? resolveAll(entries, entry.target, depth + 1) : base;
};

/**
 * Follow symlinks in every folder segment, but not the last one.
 * @param entries - Filesystem entries.
 * @param file - Path to resolve.
 */
const resolveParents = (entries: Entries, file: string): string => {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(resolveAll(entries, parent), path.basename(absolute));
};

const fileData = (entries: Entries, resolved: string): string => {
  const entry = entries.get(resolved);
  if (entry?.kind !== 'file') {
    throw errnoError(entry === undefined ? 'ENOENT' : 'EISDIR', resolved);
  }
  return entry.data;
};

const requireDir = (entries: Entries, dir: string): void => {
  if (entries.get(dir)?.kind !== 'directory') {
    throw errnoError('ENOENT', dir);
  }
};

/** In-memory filesystem implementing the `RecordFs` port. */
export class FakeRecordFs implements RecordFs {
  /** When set, every `rename` rejects with it. */
  public renameError: Error | undefined;
  /** When set, every `writeFile` rejects with it. */
  public writeError: Error | undefined;
  /** Mutating calls, e.g. `writeFile /repo/.x.tmp`. */
  public readonly calls: string[] = [];
  private readonly entries: Entries = new Map();

  public constructor(root = path.resolve('/')) {
    this.entries.set(root, { kind: 'directory' });
  }

  /**
   * Create a folder and its parents.
   * @param dir - Absolute folder path.
   */
  public addDir(dir: string): this {
    let current = path.resolve(dir);
    const missing: string[] = [];
    while (!this.entries.has(current) && path.dirname(current) !== current) {
      missing.push(current);
      current = path.dirname(current);
    }
    for (const folder of missing) {
      this.entries.set(folder, { kind: 'directory' });
    }
    return this;
  }

  /**
   * Create a file, and its parent folders.
   * @param file - Absolute file path.
   * @param data - File text.
   */
  public addFile(file: string, data: string): this {
    this.addDir(path.dirname(file));
    this.entries.set(path.resolve(file), { kind: 'file', data });
    return this;
  }

  /**
   * Create a symlink to an absolute target.
   * @param link - Link path.
   * @param target - Absolute target path.
   */
  public addSymlink(link: string, target: string): this {
    this.addDir(path.dirname(link));
    this.entries.set(path.resolve(link), { kind: 'symlink', target: path.resolve(target) });
    return this;
  }

  /**
   * Text of a file, or `undefined`.
   * @param file - Absolute file path.
   */
  public read(file: string): string | undefined {
    const entry = this.entries.get(path.resolve(file));
    return entry?.kind === 'file' ? entry.data : undefined;
  }

  /** Every path currently present. */
  public paths(): string[] {
    return [...this.entries.keys()];
  }

  public async lstat(file: string): Promise<RecordFileStat | undefined> {
    await Promise.resolve();
    let entry: Entry | undefined;
    try {
      entry = this.entries.get(resolveParents(this.entries, file));
    } catch {
      return undefined;
    }
    if (entry === undefined) {
      return undefined;
    }
    return { kind: entry.kind, size: entry.kind === 'file' ? Buffer.byteLength(entry.data) : 0 };
  }

  public async realpath(file: string): Promise<string> {
    await Promise.resolve();
    return resolveAll(this.entries, file);
  }

  public async readCapped(file: string, maxBytes: number): Promise<Uint8Array> {
    const data = fileData(this.entries, await this.realpath(file));
    return Buffer.from(data, 'utf8').subarray(0, maxBytes);
  }

  public async hashFile(file: string): Promise<string> {
    const data = fileData(this.entries, await this.realpath(file));
    return `sha256:${createHash('sha256').update(data).digest('hex')}`;
  }

  public async writeFile(file: string, contents: string): Promise<void> {
    this.calls.push(`writeFile ${file}`);
    await Promise.resolve();
    if (this.writeError !== undefined) {
      throw this.writeError;
    }
    const resolved = resolveParents(this.entries, file);
    if (this.entries.has(resolved)) {
      throw errnoError('EEXIST', resolved);
    }
    requireDir(this.entries, path.dirname(resolved));
    this.entries.set(resolved, { kind: 'file', data: contents });
  }

  public async rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename ${from} ${to}`);
    await Promise.resolve();
    if (this.renameError !== undefined) {
      throw this.renameError;
    }
    const source = resolveParents(this.entries, from);
    const entry = this.entries.get(source);
    if (entry === undefined) {
      throw errnoError('ENOENT', source);
    }
    this.entries.delete(source);
    this.entries.set(resolveParents(this.entries, to), entry);
  }

  public async unlink(file: string): Promise<void> {
    this.calls.push(`unlink ${file}`);
    await Promise.resolve();
    const resolved = resolveParents(this.entries, file);
    const entry = this.entries.get(resolved);
    if (entry === undefined) {
      throw errnoError('ENOENT', resolved);
    }
    if (entry.kind === 'directory') {
      throw errnoError('EISDIR', resolved);
    }
    this.entries.delete(resolved);
  }

  public async mkdir(dir: string, opts?: { recursive?: boolean }): Promise<void> {
    this.calls.push(`mkdir ${dir}`);
    await Promise.resolve();
    if (opts?.recursive) {
      this.addDir(dir);
      return;
    }
    const resolved = resolveParents(this.entries, dir);
    requireDir(this.entries, path.dirname(resolved));
    this.entries.set(resolved, { kind: 'directory' });
  }

  public async readdir(dir: string): Promise<string[]> {
    await Promise.resolve();
    const resolved = resolveAll(this.entries, dir);
    return this.paths().filter((p) => path.dirname(p) === resolved && p !== resolved).map((p) => path.basename(p));
  }

  public async exists(file: string): Promise<boolean> {
    return (await this.lstat(file)) !== undefined;
  }

  public async appendFile(file: string, contents: string): Promise<void> {
    this.calls.push(`appendFile ${file}`);
    await Promise.resolve();
    const resolved = resolveAll(this.entries, path.dirname(file));
    const target = path.join(resolved, path.basename(file));
    const existing = this.entries.get(target);
    requireDir(this.entries, resolved);
    this.entries.set(target, { kind: 'file', data: `${existing?.kind === 'file' ? existing.data : ''}${contents}` });
  }
}
