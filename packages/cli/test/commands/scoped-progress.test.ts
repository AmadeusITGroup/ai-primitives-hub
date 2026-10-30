import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  expect,
  it,
} from 'vitest';
import {
  HubValidateCommand,
} from '../../src/commands/hub';
import {
  createTestContext,
  runCli,
} from '../../src/framework';

it('emits scoped deep, inventory and request progress only on stderr with verbose enabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scoped-progress-v2-'));
  try {
    await writeFile(path.join(root, 'hub-config.yml'), JSON.stringify({ version: '1.0.0',
      metadata: { name: 'Hub', description: 'Hub', maintainer: 'Test', updatedAt: '2026-01-01T00:00:00Z' },
      sources: [{ id: 'a', type: 'github', url: 'https://github.com/owner/a', enabled: true, priority: 0 }], profiles: [] }));
    await writeFile(path.join(root, 'scope.json'), JSON.stringify({ schemaVersion: 1, sourceIds: ['a'], profileIds: [] }));
    for (const verbose of [false, true]) {
      const ctx = createTestContext({ cwd: root, fs: new NodeFileSystem(), env: {} });
      const exitCode = await runCli(['hub', 'validate', '--governance', '--scope-file', 'scope.json', '--check-sources', '-o', 'json', ...(verbose ? ['--verbose'] : [])], {
        ctx, name: 'test', version: 'test', commands: [], commandClasses: [HubValidateCommand],
        tokens: { getToken: () => Promise.resolve('SECRET_TOKEN') },
        http: { fetch: (request) => Promise.resolve({ statusCode: 200,
          body: Buffer.from(new URL(request.url).pathname.endsWith('/releases') ? '[]' : '{"full_name":"owner/a"}'),
          headers: {}, finalUrl: request.url }) }
      });
      expect(exitCode, ctx.stdout.captured() + ctx.stderr.captured()).toBe(0);
      expect(JSON.parse(ctx.stdout.captured()).data.verdict).toBe('pass');
      const stderr = ctx.stderr.captured();
      expect(stderr).not.toMatch(/SECRET_TOKEN|https?:\/\/|Authorization/);
      if (verbose) {
        expect(stderr).toContain('[scoped validation]');
        expect(stderr).not.toContain('[governance source]');
        expect(stderr).toContain('"phase":"completed"');
        expect(stderr).toContain('"kind":"success"');
      } else {
        expect(stderr).toBe('');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
