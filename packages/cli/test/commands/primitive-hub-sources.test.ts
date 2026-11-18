import {
  execFileSync,
} from 'node:child_process';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildZip,
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  expect,
  it,
} from 'vitest';
import {
  PrimitiveValidateCommand,
} from '../../src/commands/primitive-validate';
import {
  createTestContext,
  runCli,
} from '../../src/framework';

it('downloads a hub PR source and validates its collection primitives through the CLI', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'primitive-hub-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    const config = 'version: 1.0.0\nmetadata:\n  name: Test\n  description: Test\n  maintainer: Test\n  updatedAt: "2026-01-01T00:00:00Z"\nprofiles: []\n';
    const commit = () => {
      git('add', '-A');
      git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'test');
      return git('rev-parse', 'HEAD');
    };
    await writeFile(path.join(root, 'custom.yml'), `${config}sources: []\n`);
    const base = commit();
    await writeFile(path.join(root, 'custom.yml'), `${config}sources:\n  - id: added\n    name: Added\n    type: github\n`
    + '    url: https://github.com/owner/added\n    enabled: true\n    priority: 1\n');
    const head = commit();
    const archive = buildZip(Object.entries({
      'collections/test.collection.yml': 'id: test\nname: Test\nauthor: Team\nitems:\n  - path: test.prompt.md\n    kind: prompt\n',
      'test.prompt.md': 'Missing frontmatter'
    }).map(([file, content]) => ({ path: `owner-added-sha/${file}`, bytes: Buffer.from(content) })));
    const ctx = createTestContext({ cwd: root, fs: new NodeFileSystem(), env: {} });
    const requests: string[] = [];
    const code = await runCli(['primitive', 'validate', '--config', 'custom.yml', '--base-ref', base, '--head-ref', head, '-o', 'json'], {
      ctx, commands: [], commandClasses: [PrimitiveValidateCommand],
      tokens: { getToken: () => Promise.resolve(undefined) },
      http: { fetch: (request) => {
        requests.push(new URL(request.url).pathname);
        return Promise.resolve({ statusCode: 200, body: archive, headers: {}, finalUrl: request.url });
      } }
    });
    expect(code).toBe(0);
    expect(requests).toEqual(['/repos/owner/added/zipball']);
    const report = JSON.parse(ctx.stdout.captured()).data;
    expect(report.prScope.validated).toEqual(['added/test.prompt.md']);
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'PRM001', severity: 'warning', file: 'added/test.prompt.md' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
