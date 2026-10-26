/**
 * `snapshotTree` tests: every file under a root, labelled with the sandbox
 * roots and hashed with core `sha256Hex`.
 */
import * as path from 'node:path';
import {
  sha256Hex,
  type SnapshotRoot,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  listExecutableLabels,
  snapshotTree,
} from '../../src';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const encoder = new TextEncoder();
/**
 * Native absolute path of a rooted POSIX-style fixture path: on win32 it
 * gains the current drive, as every `path.join` result does.
 * @param posix - Rooted fixture path.
 * @returns Absolute path for this platform.
 */
const abs = (posix: string): string => path.resolve(posix);

const ROOTS: SnapshotRoot[] = [
  { label: '$XDG_CONFIG_HOME', path: abs('/run/cases/c1/home/xdg') },
  { label: '$HOME', path: abs('/run/cases/c1/home') },
  { label: '<workspace>', path: abs('/run/cases/c1/ws') },
  { label: '<case>', path: abs('/run/cases/c1') }
];

describe('snapshotTree', () => {
  it('labels and hashes every file under the root, at any depth', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(abs('/run/cases/c1/home/.copilot/prompts/a.prompt.md'), encoder.encode('a'));
    fs.seed(abs('/run/cases/c1/home/xdg/ai-primitives-hub/lock.json'), encoder.encode('{}'));
    fs.seed(abs('/run/cases/c1/ws/ai-primitives-hub.yml'), encoder.encode('targets: []'));
    fs.seed(abs('/run/cases/c1/stray'), encoder.encode('s'));
    fs.seed(abs('/run/cases/c2/home/other.md'), encoder.encode('not in c1'));

    const snapshot = await snapshotTree(fs, abs('/run/cases/c1'), ROOTS);

    expect([...snapshot.entries()]).toEqual([
      ['$HOME/.copilot/prompts/a.prompt.md', sha256Hex(encoder.encode('a'))],
      ['$XDG_CONFIG_HOME/ai-primitives-hub/lock.json', sha256Hex(encoder.encode('{}'))],
      ['<case>/stray', sha256Hex(encoder.encode('s'))],
      ['<workspace>/ai-primitives-hub.yml', sha256Hex(encoder.encode('targets: []'))]
    ]);
  });

  it('returns an empty snapshot for a missing root', async () => {
    const fs = new InMemoryFileSystem();

    const snapshot = await snapshotTree(fs, abs('/run/cases/missing'), ROOTS);

    expect(snapshot.size).toBe(0);
  });

  it('throws on a path outside every root', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(abs('/elsewhere/file.md'), encoder.encode('x'));

    await expect(snapshotTree(fs, abs('/elsewhere'), ROOTS)).rejects.toThrow(abs('/elsewhere/file.md'));
  });
});

describe('listExecutableLabels', () => {
  it('labels the files with an execute bit, at any depth', async () => {
    const fs = new InMemoryFileSystem({ modes: true });
    fs.seed(abs('/run/cases/c1/home/.copilot/skills/s/scripts/run.sh'), 'x');
    fs.seed(abs('/run/cases/c1/home/.copilot/skills/s/SKILL.md'), 'x');
    fs.seed(abs('/run/cases/c1/ws/tool.sh'), 'x');
    fs.setMode(abs('/run/cases/c1/home/.copilot/skills/s/scripts/run.sh'), 0o755);
    fs.setMode(abs('/run/cases/c1/ws/tool.sh'), 0o700);

    const labels = await listExecutableLabels(fs, abs('/run/cases/c1'), ROOTS);

    expect(labels).toEqual(new Set(['$HOME/.copilot/skills/s/scripts/run.sh', '<workspace>/tool.sh']));
  });

  it('returns an empty set for a missing root, and undefined when the filesystem reports no modes', async () => {
    await expect(listExecutableLabels(new InMemoryFileSystem({ modes: true }), abs('/run/cases/missing'), ROOTS)).resolves.toEqual(new Set());
    const plain = new InMemoryFileSystem();
    plain.seed(abs('/run/cases/c1/home/a.sh'), 'x');
    await expect(listExecutableLabels(plain, abs('/run/cases/c1'), ROOTS)).resolves.toBeUndefined();
  });
});
