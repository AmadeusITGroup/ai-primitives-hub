import {
  mkdir,
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
});
