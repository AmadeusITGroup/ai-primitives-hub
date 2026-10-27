/**
 * Tests for infra/writers/git-info-exclude.ts.
 *
 * The exact `.git/info/exclude` bytes match the repository-scope writer
 * characterisation (repo-scope-writer.characterisation.test.ts), now
 * asserted against the adapter directly.
 */
import type {
  RepositoryExclusion,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  GitInfoExclude,
} from '../../src/writers/git-info-exclude';
import {
  RepositoryScopeWriter,
} from '../../src/writers/repo-scope-writer';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const WORKSPACE_ROOT = '/workspace';
const EXCLUDE_PATH = '/workspace/.git/info/exclude';
const HEADER = '# Prompt Registry (local)';
const PATHS = [
  '/workspace/.github/prompts/x.prompt.md',
  '/workspace/.github/skills/foo/SKILL.md',
  '/workspace/.github/skills/foo/references/ref.md'
];

const readExclude = async (fs: InMemoryFileSystem): Promise<string | null> =>
  (await fs.exists(EXCLUDE_PATH)) ? fs.readFile(EXCLUDE_PATH) : null;

const setup = (seed?: string): { fs: InMemoryFileSystem; exclusion: GitInfoExclude } => {
  const fs = new InMemoryFileSystem();
  if (seed !== undefined) {
    fs.seed(EXCLUDE_PATH, seed);
  }
  return { fs, exclusion: new GitInfoExclude({ fs, workspaceRoot: WORKSPACE_ROOT }) };
};

describe('GitInfoExclude', () => {
  it('creates the file with the section header and the relative paths', async () => {
    const { fs, exclusion } = setup();
    await exclusion.add(PATHS);
    expect(await readExclude(fs)).toBe(
      `${HEADER}\n.github/prompts/x.prompt.md\n.github/skills/foo/SKILL.md\n.github/skills/foo/references/ref.md`
    );
  });

  it('keeps the header when every path is removed again', async () => {
    const { fs, exclusion } = setup();
    await exclusion.add(PATHS);
    await exclusion.remove(PATHS);
    expect(await readExclude(fs)).toBe(HEADER);
  });

  it('appends a section to an existing file without the header', async () => {
    const { fs, exclusion } = setup('node_modules\n');
    await exclusion.add(PATHS);
    expect(await readExclude(fs)).toBe(
      `node_modules\n\n${HEADER}\n.github/skills/foo/references/ref.md\n.github/skills/foo/SKILL.md\n.github/prompts/x.prompt.md`
    );
  });

  it('inserts below an existing header, keeping earlier entries', async () => {
    const { fs, exclusion } = setup(`node_modules\n${HEADER}\n.github/prompts/old.prompt.md\n`);
    await exclusion.add(PATHS);
    expect(await readExclude(fs)).toBe(
      `node_modules\n${HEADER}\n.github/skills/foo/references/ref.md\n.github/skills/foo/SKILL.md\n`
      + '.github/prompts/x.prompt.md\n.github/prompts/old.prompt.md\n'
    );
  });

  it('does not list a path twice', async () => {
    const { fs, exclusion } = setup();
    await exclusion.add(PATHS.slice(0, 1));
    await exclusion.add(PATHS.slice(0, 1));
    expect(await readExclude(fs)).toBe(`${HEADER}\n.github/prompts/x.prompt.md`);
  });

  it('creates the header for an empty add', async () => {
    const { fs, exclusion } = setup();
    await exclusion.add([]);
    expect(await readExclude(fs)).toBe(HEADER);
  });

  it('leaves a missing file or a file without the header untouched on remove', async () => {
    const missing = setup();
    await missing.exclusion.remove(PATHS);
    expect(await readExclude(missing.fs)).toBeNull();

    const noHeader = setup('node_modules\n.github/prompts/x.prompt.md\n');
    await noHeader.exclusion.remove(PATHS);
    expect(await readExclude(noHeader.fs)).toBe('node_modules\n.github/prompts/x.prompt.md\n');
  });
});

describe('RepositoryScopeWriter exclusion option', () => {
  const MANIFEST = `formatVersion: 1
id: small
version: 1.0.0
name: Small
items:
  - { path: prompts/x.prompt.md, kind: prompt, id: x.prompt }
`;
  const files = (): Map<string, Uint8Array> => new Map([
    ['deployment-manifest.yml', new TextEncoder().encode(MANIFEST)],
    ['prompts/x.prompt.md', new TextEncoder().encode('# Prompt\n')]
  ]);

  class RecordingExclusion implements RepositoryExclusion {
    public readonly added: string[][] = [];
    public readonly removed: string[][] = [];
    public add(paths: readonly string[]): Promise<void> {
      this.added.push([...paths]);
      return Promise.resolve();
    }

    public remove(paths: readonly string[]): Promise<void> {
      this.removed.push([...paths]);
      return Promise.resolve();
    }
  }

  it('sends written paths to the injected exclusion in local-only mode', async () => {
    const fs = new InMemoryFileSystem();
    const exclusion = new RecordingExclusion();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only', exclusion });
    const result = await writer.write(files());
    await writer.rollback(result.written);
    // The writer joins paths with the platform's separator.
    const toPosix = (calls: string[][]): string[][] => calls.map((paths) => paths.map((p) => p.replaceAll('\\', '/')));
    expect(toPosix(exclusion.added)).toEqual([['/workspace/.github/prompts/x.prompt.md']]);
    expect(toPosix(exclusion.removed)).toEqual([['/workspace/.github/prompts/x.prompt.md']]);
    expect(await readExclude(fs)).toBeNull();
  });

  it('sends nothing to the injected exclusion in commit mode', async () => {
    const fs = new InMemoryFileSystem();
    const exclusion = new RecordingExclusion();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit', exclusion });
    const result = await writer.write(files());
    await writer.rollback(result.written);
    expect(exclusion.added).toEqual([]);
    expect(exclusion.removed).toEqual([]);
  });
});
