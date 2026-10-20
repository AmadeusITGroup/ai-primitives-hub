import {
  execFileSync,
} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
  ZipBundleExtractor,
} from '@ai-primitives-hub/infra';
import * as yaml from 'js-yaml';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  BundleBuildCommand,
} from '../../src/commands/bundle-build';
import {
  runCommand,
} from '../../src/framework';

describe('bundle build environment placeholders', () => {
  for (const governed of [true, false]) {
    it(`preserves placeholders in standalone and archived ${governed ? 'governed' : 'legacy'} manifests`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'bundle-env-'));
      try {
        await mkdir(path.join(root, 'collections'));
        await mkdir(path.join(root, 'prompts'));
        await writeFile(path.join(root, 'prompts', 'hello.prompt.md'), '# Hello\n');
        const headers = {
          'x-token': 'Token ${env:APH_TEST_TOKEN}',
          'x-empty': '${env:APH_TEST_TOKEN:-}',
          'x-default': '${env:APH_TEST_USER:-anonymous}'
        };
        await writeFile(path.join(root, 'collections', 'example.collection.yml'), yaml.dump({
          id: 'example', name: 'Example',
          items: [{ path: 'prompts/hello.prompt.md', kind: 'prompt' }],
          mcp: { items: { gateway: { type: 'http', url: 'https://example.invalid/mcp', headers, disabled: true } } }
        }));
        if (governed) {
          await writeFile(path.join(root, 'LICENSE'), 'Test fixture license\n');
        }
        execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Test Fixture'], { cwd: root });
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/collection.git'], { cwd: root });
        execFileSync('git', ['add', '.'], { cwd: root });
        execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });

        const result = await runCommand([
          'bundle', 'build', '--version', '1.0.0',
          '--collection-file', 'collections/example.collection.yml', '-o', 'json'
        ], {
          commandClasses: [BundleBuildCommand],
          context: { cwd: root, fs: new NodeFileSystem(), env: { HOME: root, USERPROFILE: root } }
        });
        expect(result.exitCode, result.stderr).toBe(0);
        const { data } = JSON.parse(result.stdout) as { data: { manifestAsset: string; zipAsset: string } };
        const standalone = await readFile(data.manifestAsset, 'utf8');
        const files = await new ZipBundleExtractor().extract(await readFile(data.zipAsset));
        const archived = new TextDecoder().decode(files.get('deployment-manifest.yml'));
        expect(archived).toBe(standalone);
        for (const content of [standalone, archived]) {
          const manifest = yaml.load(content) as {
            formatVersion?: number;
            mcpServers: Record<string, { headers: Record<string, string>; disabled: boolean }>;
          };
          expect(manifest.formatVersion).toBe(governed ? 1 : undefined);
          expect(manifest.mcpServers.gateway.headers).toEqual(headers);
          expect(manifest.mcpServers.gateway.disabled).toBe(true);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
