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

it('reports safe verbose source/request progress while retaining machine-readable stdout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'governance-progress-'));
  try {
    await writeFile(path.join(root, 'hub-config.yml'), `version: 1.0.0
metadata:
  name: Test
  description: Test
  maintainer: Test
  updatedAt: '2026-10-14T00:00:00Z'
sources:
  - id: first
    type: github
    url: https://github.com/owner/repo
    enabled: true
    priority: 1
profiles: []
`);
    for (const verbose of [false, true]) {
      const ctx = createTestContext({ cwd: root, fs: new NodeFileSystem(), env: {} });
      const code = await runCli(['hub', 'validate', '--governance', '--check-sources', '-o', 'json', ...(verbose ? ['--verbose'] : [])], {
        ctx, name: 'test', version: 'test', commands: [], commandClasses: [HubValidateCommand],
        tokens: { getToken: () => Promise.resolve('SECRET_TOKEN') },
        http: { fetch: (request) => Promise.resolve({ statusCode: 200, body: Buffer.from('[]'),
          headers: {}, finalUrl: request.url }) }
      });
      expect(code).toBe(0);
      expect(JSON.parse(ctx.stdout.captured()).data.verdict).toBe('pass');
      const stderr = ctx.stderr.captured();
      expect(stderr).not.toMatch(/SECRET_TOKEN|https?:\/\/|per_page|Authorization/);
      if (verbose) {
        expect(stderr).toContain('[governance source]');
        expect(stderr).toContain('"phase":"complete"');
        expect(stderr).toContain('"kind":"success"');
        expect(stderr).toContain('"resource":"releases"');
      } else {
        expect(stderr).toBe('');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
