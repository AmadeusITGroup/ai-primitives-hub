import {
  chmod,
  mkdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  join,
} from 'node:path';
import type {
  SecurityCancellation,
  SecurityInputRequest,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  NodeSecurityScanInput,
  SECURITY_DEFAULT_LIMITS,
} from '../../src/security';
import {
  createTempDir,
} from '../helpers/temp-dir';

const cancellation: SecurityCancellation = {
  cancelled: false,
  throwIfCancelled: () => undefined
};

const request = (root: string): SecurityInputRequest => ({
  roots: [root],
  extensions: ['.md'],
  recursive: true,
  excludes: ['node_modules', '.git'],
  includeDocFiles: false,
  ignoreTrust: 'repository'
});

describe('NodeSecurityScanInput', () => {
  let directory: string;
  let cleanup: () => void;

  beforeEach(() => {
    [directory, cleanup] = createTempDir('security-input-');
  });

  afterEach(() => cleanup());

  it('collects bounded markdown files with deterministic relative paths', async () => {
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'nested', 'b.md'), '# b');
    await writeFile(join(directory, 'a.md'), '# a');
    await writeFile(join(directory, 'README.md'), '# readme');

    const result = await new NodeSecurityScanInput().collect(request(directory), SECURITY_DEFAULT_LIMITS, cancellation);

    expect(result.candidates.map((candidate) => candidate.displayPath)).toEqual(['a.md', 'nested/b.md']);
    expect(result.skippedFiles).toContainEqual({ path: join(directory, 'README.md'), reason: 'documentation-default' });
    const read = await new NodeSecurityScanInput().read(result.candidates[0], SECURITY_DEFAULT_LIMITS, cancellation);
    expect(read.document?.content).toBe('# a');
  });

  it('uses the containing directory as the root for a direct file input', async () => {
    const file = join(directory, 'direct.md');
    await writeFile(file, '# direct');

    const result = await new NodeSecurityScanInput().collect(request(file), SECURITY_DEFAULT_LIMITS, cancellation);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].rootId).toBe(directory);
    expect(result.candidates[0].displayPath).toBe('direct.md');
  });

  it('counts overlapping and repeated roots only once against the file budget', async () => {
    const file = join(directory, 'a.md');
    await writeFile(file, '# file');
    const result = await new NodeSecurityScanInput().collect(
      { ...request(directory), roots: [directory, file, directory], ignoreTrust: 'none' },
      { ...SECURITY_DEFAULT_LIMITS, maxFiles: 1 }, cancellation
    );
    expect(result.candidates.map((candidate) => candidate.absolutePath)).toEqual([file]);
    expect(result.errors).toEqual([]);
  });

  it('applies exclusions to explicitly named files', async () => {
    const file = join(directory, 'excluded.md');
    await writeFile(file, '# file');
    const result = await new NodeSecurityScanInput().collect(
      { ...request(file), excludes: ['excluded.md'] }, SECURITY_DEFAULT_LIMITS, cancellation
    );
    expect(result.candidates).toEqual([]);
    expect(result.skippedFiles).toContainEqual({ path: file, reason: 'excluded' });
  });

  it('reads root suppressions and malformed-entry warnings only once', async () => {
    await writeFile(join(directory, 'a.md'), '# file');
    await writeFile(join(directory, '.markdown.ignore'), `${'a'.repeat(32)}\nnot-a-fingerprint\n`);
    const result = await new NodeSecurityScanInput().collect(request(directory), SECURITY_DEFAULT_LIMITS, cancellation);
    expect(result.suppressions).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it('bounds wildcard matching for long nonmatching filenames', async () => {
    await writeFile(join(directory, `${'x'.repeat(180)}.md`), '# file');
    await writeFile(join(directory, '.markdown-file.ignore'), '********a\n*x*x*x*x*x*b\n');
    const start = performance.now();
    const result = await new NodeSecurityScanInput().collect(request(directory), SECURITY_DEFAULT_LIMITS, cancellation);
    expect(result.candidates).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('preserves component, globstar and question-mark ignore semantics', async () => {
    await mkdir(join(directory, 'nested', 'deep'), { recursive: true });
    await writeFile(join(directory, 'nested', 'deep', 'a1.md'), '# file');
    await writeFile(join(directory, 'nested', 'a2.md'), '# file');
    await writeFile(join(directory, '.markdown-file.ignore'), 'nested/*/a?.md\n');
    const input = new NodeSecurityScanInput();
    const first = await input.collect(request(directory), SECURITY_DEFAULT_LIMITS, cancellation);
    expect(first.candidates.map((entry) => entry.displayPath)).toEqual(['nested/a2.md']);
    await writeFile(join(directory, '.markdown-file.ignore'), 'nested/**a?.md\n');
    expect((await input.collect(request(directory), SECURITY_DEFAULT_LIMITS, cancellation)).candidates).toEqual([]);
  });

  it('rejects a candidate moved behind a symlinked parent before reading', async () => {
    const nested = join(directory, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'a.md'), '# file');
    const input = new NodeSecurityScanInput();
    const result = await input.collect(request(directory), SECURITY_DEFAULT_LIMITS, cancellation);
    await rename(nested, join(directory, 'moved'));
    await symlink(join(directory, 'moved'), nested, 'junction');
    const read = await input.read(result.candidates[0], SECURITY_DEFAULT_LIMITS, cancellation);
    expect(read.document).toBeUndefined();
    expect(read.error?.code).toBe('SECURITY.INPUT_CHANGED');
  });

  it('collects directly passed Claude settings and preserves file mode metadata', async () => {
    const claudeDirectory = join(directory, '.claude');
    await mkdir(claudeDirectory);
    const file = join(claudeDirectory, 'settings.json');
    await writeFile(file, '{"permissions":{"allow":["Bash(*)"]}}');
    await chmod(file, 0o666);

    const input = new NodeSecurityScanInput();
    const result = await input.collect(request(file), SECURITY_DEFAULT_LIMITS, cancellation);
    const read = await input.read(result.candidates[0], SECURITY_DEFAULT_LIMITS, cancellation);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].displayPath).toBe('settings.json');
    expect(read.document).toMatchObject({
      displayPath: 'settings.json',
      metadata: { posixMode: expect.any(Number) }
    });
    expect(Math.floor((read.document?.metadata.posixMode ?? 0) / 2) % 2).toBe(1);
  });

  it('auto-includes nested Claude settings independently of markdown extensions', async () => {
    const claudeDirectory = join(directory, '.claude');
    await mkdir(claudeDirectory);
    await writeFile(join(claudeDirectory, 'settings.local.json'), '{}');

    const result = await new NodeSecurityScanInput().collect(request(directory), SECURITY_DEFAULT_LIMITS, cancellation);

    expect(result.candidates.map((candidate) => candidate.displayPath)).toContain('.claude/settings.local.json');
  });

  it('honors hierarchical file and finding ignore files', async () => {
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'a.md'), '# a');
    await writeFile(join(directory, 'nested', 'b.md'), '# b');
    await writeFile(join(directory, '.markdown-file.ignore'), 'nested/*.md\n');
    await writeFile(join(directory, '.markdown.ignore'), `${'a'.repeat(32)} # rationale\n`);

    const result = await new NodeSecurityScanInput().collect(request(directory), SECURITY_DEFAULT_LIMITS, cancellation);

    expect(result.ignoredFiles).toContainEqual(expect.objectContaining({ path: join(directory, 'nested', 'b.md') }));
    expect(result.suppressions).toContainEqual(expect.objectContaining({ token: 'a'.repeat(32), scopeRoot: directory }));
  });

  it('does not follow directory symlinks', async () => {
    const outside = '/tmp';
    await symlink(outside, join(directory, 'linked'));

    const result = await new NodeSecurityScanInput().collect(request(directory), SECURITY_DEFAULT_LIMITS, cancellation);

    expect(result.candidates).toHaveLength(0);
    expect(result.skippedFiles).toContainEqual({ path: join(directory, 'linked'), reason: 'symlink' });
  });

  it('rejects files larger than the configured byte limit', async () => {
    const file = join(directory, 'large.md');
    await writeFile(file, '123456789');
    const result = await new NodeSecurityScanInput().collect(request(directory), SECURITY_DEFAULT_LIMITS, cancellation);
    const read = await new NodeSecurityScanInput().read(result.candidates[0], { ...SECURITY_DEFAULT_LIMITS, maxFileBytes: 4 }, cancellation);
    expect(read.error?.code).toBe('SECURITY.LIMIT_EXCEEDED');
  });

  it('enforces the file count for explicitly named files', async () => {
    const files = [join(directory, 'a.md'), join(directory, 'b.md')];
    await Promise.all(files.map((file) => writeFile(file, '# file')));
    const result = await new NodeSecurityScanInput().collect(
      { ...request(directory), roots: files }, { ...SECURITY_DEFAULT_LIMITS, maxFiles: 1 }, cancellation
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'SECURITY.LIMIT_EXCEEDED' }));
  });

  it('applies baseline file ignores to explicitly named files', async () => {
    const file = join(directory, 'a.md');
    const baseline = join(directory, 'trusted.ignore');
    await writeFile(file, '# file');
    await writeFile(baseline, 'a.md');
    const result = await new NodeSecurityScanInput().collect(
      { ...request(file), ignoreTrust: 'baseline', baselineFileIgnorePath: baseline },
      SECURITY_DEFAULT_LIMITS, cancellation
    );
    expect(result.candidates).toEqual([]);
    expect(result.ignoredFiles).toContainEqual(expect.objectContaining({ path: file, source: baseline }));
  });

  it('reports an unavailable explicit baseline instead of silently scanning without it', async () => {
    const result = await new NodeSecurityScanInput().collect(
      { ...request(directory), ignoreTrust: 'baseline', baselineSuppressionPath: join(directory, 'missing.ignore') },
      SECURITY_DEFAULT_LIMITS, cancellation
    );
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'SECURITY.INPUT_UNREADABLE' }));
  });

  it('reports oversized ignore files instead of silently discarding them', async () => {
    await writeFile(join(directory, '.markdown.ignore'), 'a'.repeat(50));
    const result = await new NodeSecurityScanInput().collect(
      request(directory), { ...SECURITY_DEFAULT_LIMITS, maxIgnoreBytes: 10 }, cancellation
    );
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'SECURITY.LIMIT_EXCEEDED' }));
  });

  it('stops ignore inheritance at a git worktree marker file', async () => {
    await mkdir(join(directory, 'worktree'));
    await writeFile(join(directory, '.markdown-file.ignore'), '*.md');
    await writeFile(join(directory, 'worktree', '.git'), 'gitdir: /repo/.git/worktrees/demo');
    await writeFile(join(directory, 'worktree', 'a.md'), '# file');
    const result = await new NodeSecurityScanInput().collect(
      request(join(directory, 'worktree')), SECURITY_DEFAULT_LIMITS, cancellation
    );
    expect(result.candidates.map((candidate) => candidate.displayPath)).toEqual(['a.md']);
  });

  it('records depth truncation as incomplete coverage', async () => {
    await mkdir(join(directory, 'nested', 'deep'), { recursive: true });
    await writeFile(join(directory, 'nested', 'deep', 'a.md'), '# file');
    const result = await new NodeSecurityScanInput().collect(
      request(directory), { ...SECURITY_DEFAULT_LIMITS, maxDepth: 1 }, cancellation
    );
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'SECURITY.LIMIT_EXCEEDED' }));
    expect(result.skippedFiles).toContainEqual({ path: join(directory, 'nested', 'deep'), reason: 'max-depth' });
  });
});
