/**
 * Tests for app/install/target-writer-factory.ts.
 */
import * as path from 'node:path';
import type {
  Target,
} from '@ai-primitives-hub/core';
import {
  LAYOUTS_CONFIG_FILE,
  RepositoryScopeWriterAdapter,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createTargetWriterFactory,
} from '../../src/install/target-writer-factory';
import {
  FileTreeTargetWriter,
} from '../../src/writers/file-tree-writer';
import {
  seedGitDir,
} from '../helpers/git-dir';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const env = { HOME: '/home/u' };

const factoryFor = (fs: InMemoryFileSystem, overrides: { projectDir?: string | null; writerOwnsExclusion?: boolean } = {}) =>
  createTargetWriterFactory({
    fs,
    env,
    projectDir: overrides.projectDir ?? null,
    userConfigDir: null,
    writerOwnsExclusion: overrides.writerOwnsExclusion ?? true
  });

describe('createTargetWriterFactory', () => {
  it.each(['vscode', 'vscode-insiders', 'copilot-cli'] as const)(
    'gives a %s repository target the repository-scope writer',
    (type) => {
      const writer = factoryFor(new InMemoryFileSystem())({ name: 't', type, scope: 'repository', rootPath: '/ws' });
      expect(writer).toBeInstanceOf(RepositoryScopeWriterAdapter);
    }
  );

  it.each([
    { type: 'vscode', scope: 'user' },
    { type: 'copilot-cli', scope: 'user' },
    { type: 'kiro', scope: 'user' },
    { type: 'kiro', scope: 'repository' },
    { type: 'cursor', scope: 'repository' },
    { type: 'devin', scope: 'repository' }
  ] as const)('gives a $type $scope target the file-tree writer', ({ type, scope }) => {
    const writer = factoryFor(new InMemoryFileSystem())({ name: 't', type, scope, rootPath: '/ws' });
    expect(writer).toBeInstanceOf(FileTreeTargetWriter);
  });

  it.each([undefined, ''])('rejects a repository target with rootPath %j', (rootPath) => {
    const target = { name: 't', type: 'vscode', scope: 'repository', ...(rootPath === undefined ? {} : { rootPath }) } as Target;
    expect(() => factoryFor(new InMemoryFileSystem())(target)).toThrow('repository target needs rootPath');
  });

  it('writes transformed content on a user kiro target', async () => {
    const fs = new InMemoryFileSystem();
    const writer = factoryFor(fs)({ name: 'k', type: 'kiro', scope: 'user' });
    const files = new Map([['agents/code-helper.md', text('---\ndescription: Helps\n---\n# Helper\n')]]);

    const result = await writer.write({ name: 'k', type: 'kiro', scope: 'user' }, files);

    const written = path.join('/home/u', '.kiro', 'agents', 'code-helper.md');
    expect(result.written).toEqual([written]);
    expect(await fs.readFile(written)).toContain('name: "Code Helper"');
  });

  it('uses the built-in layout when both layout layers are null, even with a project layout file', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(path.join('/ws', LAYOUTS_CONFIG_FILE), [
      'layouts:',
      '  kiro:',
      '    user:',
      '      baseDir: "/elsewhere"',
      '      kindRoutes:',
      '        "prompts/": "custom/"',
      ''
    ].join('\n'));
    const target: Target = { name: 'k', type: 'kiro', scope: 'repository', rootPath: '/ws' };
    const files = new Map([['prompts/a.prompt.md', text('# A')]]);

    const builtIn = await factoryFor(fs, { projectDir: null })(target).write(target, files);
    const project = await factoryFor(fs, { projectDir: '/ws' })(target).write(target, files);

    expect(builtIn.written).toEqual([path.join('/ws', '.kiro', 'steering', 'a.prompt.md')]);
    expect(project.written).toEqual([path.join('/elsewhere', 'custom', 'a.prompt.md')]);
  });

  it.each([
    { writerOwnsExclusion: false, excluded: false },
    { writerOwnsExclusion: true, excluded: true }
  ])('with writerOwnsExclusion $writerOwnsExclusion a vscode local-only write excluded: $excluded', async ({ writerOwnsExclusion, excluded }) => {
    const fs = new InMemoryFileSystem();
    seedGitDir(fs, path.join('/ws', '.git'));
    const target: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: '/ws', commitMode: 'local-only' };

    const files = new Map([
      ['deployment-manifest.yml', text('id: a\nversion: 1.0.0\nprompts:\n  - id: a\n    file: prompts/a.prompt.md\n    type: prompt\n')],
      ['prompts/a.prompt.md', text('# A')]
    ]);

    const result = await factoryFor(fs, { writerOwnsExclusion })(target).write(target, files);

    const exclude = path.join('/ws', '.git', 'info', 'exclude');
    expect(result.written).toEqual([path.join('/ws', '.github', 'prompts', 'a.prompt.md')]);
    expect(await fs.exists(exclude)).toBe(excluded);
    if (excluded) {
      expect((await fs.readFile(exclude)).split('\n')).toContain('.github/prompts/a.prompt.md');
    }
  });
});
