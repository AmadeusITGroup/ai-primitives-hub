/**
 * Contract tests for the infra install-record adapters: the schema gate and
 * the capped read of `NodeRecordFs`.
 */
import * as fs from 'node:fs';
import {
  join,
} from 'node:path';
import {
  isRecordError,
  parseRecord,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  NodeRecordFs,
  RecordSchemaValidator,
} from '../../src/records';
import {
  createTempDir,
} from '../helpers/temp-dir';

describe('RecordSchemaValidator', () => {
  it('refuses a record whose bundles are not an object with RECORD.MALFORMED', () => {
    const parsed = parseRecord(JSON.stringify({
      $schema: 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json',
      version: '3.0.0',
      level: 'repository',
      generatedAt: '2026-10-25T15:00:00Z',
      generatedBy: 'ai-primitives-hub-cli@0.3.0',
      bundles: [],
      sources: {}
    }));

    let thrown: unknown;
    try {
      new RecordSchemaValidator().validate(parsed, 'ai-primitives-hub.lock.json');
    } catch (error) {
      thrown = error;
    }

    expect(isRecordError(thrown, 'RECORD.MALFORMED')).toBe(true);
    expect((thrown as { context?: Record<string, unknown> }).context?.file).toBe('ai-primitives-hub.lock.json');
  });

  const recordWith = (entry: Record<string, unknown>, file: Record<string, unknown> = {}): unknown => parseRecord(JSON.stringify({
    $schema: 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json',
    version: '3.0.0',
    level: 'user',
    generatedAt: '2026-10-25T15:00:00Z',
    generatedBy: 'ai-primitives-hub-cli@0.3.0',
    bundles: {
      'acme-tools': {
        name: 'acme-tools',
        tools: {
          kiro: {
            version: '1.0.0', sourceId: 'acme', sourceType: 'github', installedAt: '2026-10-25T15:00:00Z',
            files: [{ path: 'steering/a.md', checksum: `sha256:${'a'.repeat(64)}`, ...file }],
            ...entry
          }
        }
      }
    },
    sources: { acme: { type: 'github', url: 'https://github.com/acme/tools' } }
  }));

  it('accepts the entry fields of the finalized lockfile: installationId, integrity, root, sourcePath, mode, plugins and MCP servers', () => {
    const parsed = recordWith({
      installationId: 'inst-3c9e1f0a',
      integrity: `sha256:${'b'.repeat(64)}`,
      root: '~/.kiro',
      plugins: [{ name: 'inspector', version: '0.4.0', manifestDigest: `sha256:${'c'.repeat(64)}`, root: 'plugins/inspector', skills: [], mcpServers: ['inspector'] }],
      mcpServers: [{ config: 'settings/mcp.json', name: 'inspector', item: 'inspector', checksum: `sha256:${'d'.repeat(64)}` }]
    }, { sourcePath: 'instructions/a.instructions.md', mode: '0755' });

    expect(() => new RecordSchemaValidator().validate(parsed, 'ai-primitives-hub.user.lock.json')).not.toThrow();
  });

  it.each([
    ['an integrity that is not sha256', { integrity: 'md5:abc' }, {}],
    ['an installationId of another form', { installationId: 'rcpt-1' }, {}],
    ['a file mode that is not octal', {}, { mode: 'rwx' }],
    ['an MCP server without its config file', { mcpServers: [{ name: 'inspector' }] }, {}]
  ])('refuses %s with RECORD.MALFORMED', (_label, entry, file) => {
    expect(() => new RecordSchemaValidator().validate(recordWith(entry, file), 'ai-primitives-hub.user.lock.json'))
      .toThrow(expect.objectContaining({ code: 'RECORD.MALFORMED' }));
  });
});

describe('NodeRecordFs.readCapped', () => {
  it('stops reading at the cap whatever the file size', async () => {
    const [dir, cleanup] = createTempDir('node-record-fs-');
    try {
      const file = join(dir, 'big.json');
      fs.writeFileSync(file, 'x'.repeat(200 * 1024));

      const bytes = await new NodeRecordFs().readCapped(file, 100 * 1024 + 1);

      expect(bytes.byteLength).toBe(100 * 1024 + 1);
    } finally {
      cleanup();
    }
  });
});

describe('NodeRecordFs', () => {
  // Covers the record store's atomic-write lifecycle on a real folder.
  it('creates exclusively, renames over, hashes and removes a record file, refusing a folder', async () => {
    const [dir, cleanup] = createTempDir('node-record-fs-');
    try {
      const recordFs = new NodeRecordFs();
      const folder = join(dir, 'sub');
      const temp = join(folder, '.record.tmp');
      const target = join(folder, 'record.json');
      await recordFs.mkdir(folder, { recursive: true });
      await recordFs.writeFile(temp, 'abc');
      await expect(recordFs.writeFile(temp, 'again')).rejects.toThrow();
      await recordFs.appendFile(temp, '\n');
      await recordFs.rename(temp, target);

      expect(await recordFs.readdir(folder)).toEqual(['record.json']);
      expect(await recordFs.lstat(target)).toMatchObject({ kind: 'file', size: 4, mode: expect.any(Number) });
      expect(await recordFs.lstat(folder)).toMatchObject({ kind: 'directory' });
      expect(await recordFs.hashFile(target)).toBe('sha256:edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb');
      expect(await recordFs.realpath(target)).toBe(fs.realpathSync.native(target));
      await expect(recordFs.unlink(folder)).rejects.toMatchObject({ code: 'EISDIR' });
      await recordFs.unlink(target);
      expect(await recordFs.exists(target)).toBe(false);
      expect(await recordFs.lstat(join(dir, 'missing', 'x'))).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
