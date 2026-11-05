/**
 * RepositoryScopeService Unit Tests
 *
 * Repository-scope install and uninstall through the shared use cases:
 * files land where the CLI puts them, the lockfile records bundle paths,
 * uninstall is guarded, local-only files are excluded from git.
 *
 * Requirements: 1.2-1.7, 3.1-3.7
 */

import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  ZipBundleExtractor,
} from '@ai-primitives-hub/infra';
import AdmZip from 'adm-zip';
import * as sinon from 'sinon';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RepositoryScopeService,
} from '../../src/services/repository-scope-service';
import type {
  IScopeService,
  SyncBundleInstall,
} from '../../src/services/scope-service';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  RepositoryCommitMode,
} from '../../src/types/registry';
import {
  Logger,
} from '../../src/utils/logger';
import {
  createRepositoryWithWorktree,
} from '../helpers/git-test-helpers';
import {
  DEMO_PLUGIN_ID,
  PluginBundleKind,
  PluginBundleZipOptions,
  writePluginBundleZip,
} from '../helpers/plugin-bundle-fixtures';

const POSIX = process.platform !== 'win32';
const EXCLUDE_HEADER = '# Prompt Registry (local)';
const sha256 = (content: string | Uint8Array): string => crypto.createHash('sha256').update(content).digest('hex');

/**
 * Extract an archive and validate its manifest as the install pipeline does.
 * @param bytes - Archive bytes.
 */
const extractBundle = async (bytes: Uint8Array): Promise<Pick<SyncBundleInstall, 'files' | 'manifest'>> => {
  const files = await new ZipBundleExtractor().extract(bytes);
  return { files, manifest: validateManifest(files, {}) };
};

suite('RepositoryScopeService', () => {
  let service: RepositoryScopeService;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let tempDir: string;
  let workspaceRoot: string;
  let sandbox: sinon.SinonSandbox;

  // ===== Test Utilities =====

  /**
   * The `install` option of a fixture bundle.
   * @param kind - Bundle content.
   * @param opts - Fixture options.
   */
  const installOf = async (kind: PluginBundleKind, opts: PluginBundleZipOptions = {}): Promise<SyncBundleInstall> => {
    const { bytes } = writePluginBundleZip(tempDir, kind, opts);
    return {
      ...await extractBundle(bytes),
      origin: { sourceId: 'local-demo', sourceType: 'local' },
      source: { type: 'local', url: 'local:local-demo' }
    };
  };

  /**
   * Install of an archive holding the given files plus a manifest listing `items`.
   * @param items - Manifest items.
   * @param files - Bundle files.
   */
  const installOfFiles = async (
    items: { id: string; file: string; type: string }[],
    files: Record<string, string>
  ): Promise<SyncBundleInstall> => {
    const zip = new AdmZip();
    const prompts = items.map((item) => `  - id: ${item.id}\n    name: ${item.id}\n    file: ${item.file}\n    type: ${item.type}`).join('\n');
    zip.addFile('deployment-manifest.yml', Buffer.from(`id: ${DEMO_PLUGIN_ID}\nversion: 1.0.0\nname: Demo\nprompts:\n${prompts}\n`));
    for (const [file, content] of Object.entries(files)) {
      zip.addFile(file, Buffer.from(content));
    }
    return {
      ...await extractBundle(zip.toBuffer()),
      origin: { sourceId: 'local-demo', sourceType: 'local' },
      source: { type: 'local', url: 'local:local-demo' }
    };
  };

  const workspacePath = (relativePath: string, root = workspaceRoot): string => path.join(root, ...relativePath.split('/'));

  const writeWorkspaceFile = (relativePath: string, content: string): void => {
    const absolute = workspacePath(relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };

  const lockfileName = (mode: RepositoryCommitMode): string => (mode === 'local-only' ? 'prompt-registry.local.lock.json' : 'prompt-registry.lock.json');

  const readEntry = (mode: RepositoryCommitMode, bundleId = DEMO_PLUGIN_ID, root = workspaceRoot) => {
    const file = path.join(root, lockfileName(mode));
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).bundles[bundleId] : undefined;
  };

  /**
   * Seed a lockfile entry as an earlier extension version wrote it.
   * @param bundleId - Bundle id.
   * @param files - Recorded files.
   * @param mode - Lockfile.
   */
  const seedLegacyEntry = (bundleId: string, files: { path: string; checksum: string }[], mode: RepositoryCommitMode = 'commit'): void => {
    fs.writeFileSync(path.join(workspaceRoot, lockfileName(mode)), JSON.stringify({
      $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      generatedBy: 'prompt-registry@test',
      bundles: {
        [bundleId]: { version: '1.0.0', sourceId: 'test-source', sourceType: 'github', installedAt: new Date().toISOString(), files }
      },
      sources: { 'test-source': { type: 'github', url: 'https://github.com/test/test' } }
    }, null, 2));
  };

  const readGitExclude = (root = workspaceRoot): string | null => {
    const excludePath = path.join(root, '.git', 'info', 'exclude');
    return fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : null;
  };

  const excludedLines = (root = workspaceRoot): string[] => {
    const lines = (readGitExclude(root) ?? '').split('\n');
    const header = lines.indexOf(EXCLUDE_HEADER);
    return header === -1 ? [] : lines.slice(header + 1).filter((line) => line.trim().length > 0).toSorted();
  };

  /**
   * Create .git directory structure
   */
  const createGitDirectory = () => {
    const gitInfoDir = path.join(workspaceRoot, '.git', 'info');
    fs.mkdirSync(gitInfoDir, { recursive: true });
  };

  const isExecutable = (file: string): boolean => (fs.statSync(file).mode & 0o100) !== 0; // eslint-disable-line no-bitwise -- owner execute bit

  setup(() => {
    sandbox = sinon.createSandbox();
    tempDir = path.join(__dirname, '..', '..', '..', 'test-temp-repo-scope');
    workspaceRoot = path.join(tempDir, 'workspace');

    fs.mkdirSync(workspaceRoot, { recursive: true });

    mockStorage = sandbox.createStubInstance(RegistryStorage);
    service = new RepositoryScopeService(workspaceRoot, mockStorage, 'vscode');
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('syncBundle', () => {
    test('installs a spec-compliant plugin into .github/plugins/<name>/ and records bundle paths', async () => {
      const install = await installOf('plugin');

      const result = await service.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install });

      const pluginDir = path.join(workspaceRoot, '.github', 'plugins', DEMO_PLUGIN_ID);
      const placed: string[] = [];
      const walk = (dir: string): void => {
        for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, dirent.name);
          if (dirent.isDirectory()) {
            walk(full);
          } else {
            placed.push(path.relative(pluginDir, full).split(path.sep).join('/'));
          }
        }
      };
      walk(pluginDir);
      assert.deepStrictEqual(placed.toSorted(), ['mcp.json', 'plugin.json', 'scripts/run.sh', 'skills/helper/SKILL.md']);
      if (POSIX) {
        assert.ok(isExecutable(path.join(pluginDir, 'scripts', 'run.sh')), 'run.sh keeps its exec bit');
      }
      const entry = readEntry('commit');
      assert.deepStrictEqual(entry.files.map((f: { path: string }) => f.path), [
        'plugins/demo-plugin/mcp.json',
        'plugins/demo-plugin/plugin.json',
        'plugins/demo-plugin/scripts/run.sh',
        'plugins/demo-plugin/skills/helper/SKILL.md'
      ]);
      assert.strictEqual(entry.targetType, 'vscode');
      assert.ok(result, 'the shared install outcome is returned');
      assert.strictEqual(result.written.length, 4);
    });

    test('records only paths of the bundle', async () => {
      const install = await installOf('mixed');

      await service.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install });

      for (const file of readEntry('commit').files as { path: string }[]) {
        assert.ok(install.files.has(file.path), `${file.path} is a bundle path`);
        assert.ok(!file.path.split('/').includes('..'), `${file.path} has no '..'`);
        assert.notStrictEqual(file.path, 'deployment-manifest.yml');
      }
    });

    test('places a mixed bundle prompt under the CLI file name', async () => {
      await service.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install: await installOf('mixed') });

      assert.ok(fs.existsSync(workspacePath('.github/prompts/hello.prompt.md')));
      assert.ok(fs.existsSync(workspacePath('.github/plugins/demo-plugin/plugin.json')));
    });

    test('places prompts, instructions, agents and skills where the VS Code layout routes them', async () => {
      const install = await installOfFiles([
        { id: 'greet', file: 'prompts/greet.prompt.md', type: 'prompt' },
        { id: 'style', file: 'instructions/style.instructions.md', type: 'instructions' },
        { id: 'helper', file: 'agents/helper.agent.md', type: 'agent' },
        { id: 'tool', file: 'skills/tool/SKILL.md', type: 'skill' }
      ], {
        'prompts/greet.prompt.md': '# Greet',
        'instructions/style.instructions.md': '# Style',
        'agents/helper.agent.md': '# Helper',
        'skills/tool/SKILL.md': '---\nname: tool\ndescription: Tool\n---\n',
        'skills/tool/scripts/go.sh': 'echo go\n'
      });

      await service.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install });

      for (const file of [
        '.github/prompts/greet.prompt.md',
        '.github/instructions/style.instructions.md',
        '.github/agents/helper.agent.md',
        '.github/skills/tool/SKILL.md',
        '.github/skills/tool/scripts/go.sh'
      ]) {
        assert.ok(fs.existsSync(workspacePath(file)), `${file} is placed`);
      }
    });

    test('throws when the extracted bundle is not given', async () => {
      await assert.rejects(
        service.syncBundle(DEMO_PLUGIN_ID, path.join(tempDir, 'cache'), { commitMode: 'commit' }),
        { message: 'Repository-scope sync needs the extracted bundle; reinstall the bundle' }
      );
    });

    test('a Kiro host rejects a plugin bundle and writes nothing', async () => {
      const kiro = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');

      await assert.rejects(
        kiro.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install: await installOf('plugin') }),
        (error: Error & { code?: string }) => error.code === 'BUNDLE.UNSUPPORTED_CONTENT'
      );

      assert.deepStrictEqual(fs.readdirSync(workspaceRoot), [], 'no file, directory or lockfile is written');
    });

    test('preflightBundle rejects what syncBundle would reject and writes nothing', async () => {
      const kiro: IScopeService = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');
      assert.ok('preflightBundle' in kiro, 'the repository scope checks a bundle before a legacy uninstall');

      await assert.rejects(
        async () => kiro.preflightBundle?.(DEMO_PLUGIN_ID, { commitMode: 'commit', install: await installOf('plugin') }),
        (error: Error & { code?: string }) => error.code === 'BUNDLE.UNSUPPORTED_CONTENT'
      );
      await kiro.preflightBundle?.(DEMO_PLUGIN_ID, { commitMode: 'commit', install: await installOf('prompt') });

      assert.deepStrictEqual(fs.readdirSync(workspaceRoot), []);
    });

    test('a Kiro host installs a prompt-only bundle local-only, excluded from git, with the written checksum', async () => {
      createGitDirectory();
      const kiro = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');

      await kiro.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'local-only', install: await installOf('prompt') });

      const steering = workspacePath('.kiro/steering/hello.prompt.md');
      assert.ok(fs.existsSync(steering));
      assert.deepStrictEqual(excludedLines(), ['.kiro/steering/hello.prompt.md', 'prompt-registry.local.lock.json']);
      const [file] = readEntry('local-only').files;
      assert.strictEqual(file.path, 'prompts/hello.prompt.md');
      assert.strictEqual(file.installedChecksum ?? file.checksum, sha256(fs.readFileSync(steering)));
      assert.deepStrictEqual(await LockfileManager.getInstance(workspaceRoot).detectModifiedFiles(DEMO_PLUGIN_ID), []);

      await kiro.unsyncBundle(DEMO_PLUGIN_ID);

      assert.ok(!fs.existsSync(steering));
      assert.deepStrictEqual(excludedLines(), []);
      assert.ok(!fs.existsSync(path.join(workspaceRoot, 'prompt-registry.local.lock.json')));
    });

    test('a Kiro install reports an edited file as modified and keeps it on uninstall', async () => {
      const kiro = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');
      await kiro.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install: await installOf('prompt') });
      const steering = workspacePath('.kiro/steering/hello.prompt.md');
      fs.appendFileSync(steering, '\nMy own line.\n');

      const modified = await LockfileManager.getInstance(workspaceRoot).detectModifiedFiles(DEMO_PLUGIN_ID);
      await kiro.unsyncBundle(DEMO_PLUGIN_ID);

      assert.deepStrictEqual(modified.map((m) => m.path), ['prompts/hello.prompt.md']);
      assert.ok(fs.existsSync(steering), 'the edited file is kept');
    });

    test('a Kiro host honours the project layout file and ignores the user one', async () => {
      const kiroLayout = (promptsRoute: string): string => [
        'layouts:',
        '  kiro:',
        '    user:',
        '      baseDir: "${HOME}/.kiro"',
        '      kindRoutes:',
        `        "prompts/": "${promptsRoute}"`,
        '    repository:',
        '      baseDir: "${workspaceRoot}/.kiro"',
        '      kindRoutes:',
        `        "prompts/": "${promptsRoute}"`,
        '      skipPaths: ["deployment-manifest.yml", "README.md"]',
        ''
      ].join('\n');
      const userConfig = path.join(tempDir, 'xdg-config');
      fs.mkdirSync(path.join(userConfig, 'ai-primitives-hub'), { recursive: true });
      fs.writeFileSync(path.join(userConfig, 'ai-primitives-hub', 'ai-primitives-hub-layouts.yml'),
        kiroLayout('user-steering/'));
      fs.writeFileSync(path.join(workspaceRoot, 'ai-primitives-hub-layouts.yml'),
        kiroLayout('project-steering/'));
      sandbox.stub(process, 'env').value({ ...process.env, XDG_CONFIG_HOME: userConfig });
      const kiro = new RepositoryScopeService(workspaceRoot, mockStorage, 'kiro');

      await kiro.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install: await installOf('prompt') });

      assert.ok(fs.existsSync(workspacePath('.kiro/project-steering/hello.prompt.md')), 'the project route applies');
      assert.ok(!fs.existsSync(workspacePath('.kiro/user-steering')), 'the user layout file is not read');
    });

    test('reinstalling over a legacy entry writes the CLI file name and removes the old file', async () => {
      writeWorkspaceFile('.github/prompts/hello-prompt.prompt.md', '# Old hello');
      seedLegacyEntry(DEMO_PLUGIN_ID, [{ path: '.github/prompts/hello-prompt.prompt.md', checksum: sha256('# Old hello') }]);

      await service.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install: await installOf('prompt') });

      assert.ok(fs.existsSync(workspacePath('.github/prompts/hello.prompt.md')));
      assert.ok(!fs.existsSync(workspacePath('.github/prompts/hello-prompt.prompt.md')));
      assert.deepStrictEqual(readEntry('commit').files.map((f: { path: string }) => f.path), ['prompts/hello.prompt.md']);
    });

    test('local-only in a git worktree excludes the files in the main repository', async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-scope-worktree-'));
      try {
        const { mainRepo, worktree } = createRepositoryWithWorktree(base);
        const inWorktree = new RepositoryScopeService(worktree, mockStorage, 'vscode');

        await inWorktree.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'local-only', install: await installOf('prompt') });

        assert.deepStrictEqual(excludedLines(mainRepo), ['.github/prompts/hello.prompt.md', 'prompt-registry.local.lock.json']);
        assert.ok(fs.existsSync(path.join(worktree, 'prompt-registry.local.lock.json')));
      } finally {
        LockfileManager.resetInstance();
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    test('local-only outside a git repository installs, warns once and creates no .git', async () => {
      const warn = sandbox.stub(Logger.getInstance(), 'warn');

      await service.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'local-only', install: await installOf('prompt') });

      assert.ok(fs.existsSync(workspacePath('.github/prompts/hello.prompt.md')));
      assert.ok(!fs.existsSync(path.join(workspaceRoot, '.git')));
      const noGit = warn.getCalls().filter((call) => String(call.args[0]).includes('local-only files are not excluded from git'));
      assert.strictEqual(noGit.length, 1, 'one warning names the missing repository');
    });
  });

  suite('unsyncBundle', () => {
    test('removes the plugin files and the directories they leave empty, deletes the lockfile and keeps .github/', async () => {
      writeWorkspaceFile('.github/workflows/ci.yml', 'on: push\n');
      await service.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install: await installOf('plugin') });

      const result = await service.unsyncBundle(DEMO_PLUGIN_ID);

      assert.ok(!fs.existsSync(workspacePath('.github/plugins')), 'no empty plugin directory is left');
      assert.ok(fs.existsSync(workspacePath('.github/workflows/ci.yml')), 'unrelated .github content is kept');
      assert.ok(!fs.existsSync(path.join(workspaceRoot, 'prompt-registry.lock.json')));
      assert.ok(result);
      assert.strictEqual(result.removed.length, 4);
    });

    test('keeps a file another bundle also installed', async () => {
      await service.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install: await installOf('mixed') });
      await service.syncBundle('other-bundle', '', { commitMode: 'commit', install: await installOf('prompt') });

      await service.unsyncBundle(DEMO_PLUGIN_ID);

      assert.ok(fs.existsSync(workspacePath('.github/prompts/hello.prompt.md')), 'the shared prompt is kept');
      assert.ok(!fs.existsSync(workspacePath('.github/plugins/demo-plugin')));
      assert.ok(readEntry('commit', 'other-bundle'));
    });

    test('keeps a file the user modified', async () => {
      await service.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install: await installOf('mixed') });
      fs.appendFileSync(workspacePath('.github/prompts/hello.prompt.md'), '\nedited\n');

      await service.unsyncBundle(DEMO_PLUGIN_ID);

      assert.ok(fs.existsSync(workspacePath('.github/prompts/hello.prompt.md')));
      assert.ok(!fs.existsSync(workspacePath('.github/plugins/demo-plugin/plugin.json')));
    });

    test('removes a legacy workspace-relative entry', async () => {
      writeWorkspaceFile('.github/prompts/old-prompt.prompt.md', '# Old');
      seedLegacyEntry('legacy', [{ path: '.github/prompts/old-prompt.prompt.md', checksum: sha256('# Old') }]);

      await service.unsyncBundle('legacy');

      assert.ok(!fs.existsSync(workspacePath('.github/prompts/old-prompt.prompt.md')));
      assert.ok(!fs.existsSync(path.join(workspaceRoot, 'prompt-registry.lock.json')));
    });

    test('removes a legacy local-only entry and its consolidated skill directory line', async () => {
      createGitDirectory();
      writeWorkspaceFile('.github/skills/helper/SKILL.md', '# Helper');
      seedLegacyEntry('legacy', [{ path: '.github/skills/helper/SKILL.md', checksum: sha256('# Helper') }], 'local-only');
      fs.writeFileSync(path.join(workspaceRoot, '.git', 'info', 'exclude'),
        `${EXCLUDE_HEADER}\n.github/skills/helper\nprompt-registry.local.lock.json\n`);

      await service.unsyncBundle('legacy');

      assert.ok(!fs.existsSync(workspacePath('.github/skills/helper/SKILL.md')));
      assert.deepStrictEqual(excludedLines(), []);
    });

    test('never deletes a file outside the workspace, whatever the lockfile says', async () => {
      const sentinelContent = 'sentinel\n';
      const sentinels = {
        parent: path.join(tempDir, 'outside', 'sentinel.txt'),
        absolute: path.join(tempDir, 'absolute-sentinel.txt'),
        dotted: path.join(tempDir, 'sentinel.txt'),
        legacyCache: path.join(tempDir, 'global', 'bundles', 'x', 'plugin.json'),
        linked: path.join(tempDir, 'linked-target', 'linked.prompt.md')
      };
      for (const file of Object.values(sentinels)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, sentinelContent);
      }
      const files = [
        { path: '../outside/sentinel.txt', checksum: sha256(sentinelContent) },
        { path: sentinels.absolute, checksum: sha256(sentinelContent) },
        { path: '.github/../../sentinel.txt', checksum: sha256(sentinelContent) },
        { path: '../global/bundles/x/plugin.json', checksum: sha256(sentinelContent) }
      ];
      if (POSIX) {
        fs.mkdirSync(workspacePath('.github'), { recursive: true });
        fs.symlinkSync(path.dirname(sentinels.linked), workspacePath('.github/prompts'), 'dir');
        files.push({ path: '.github/prompts/linked.prompt.md', checksum: sha256(sentinelContent) });
      }
      seedLegacyEntry('hostile', files);
      const warn = sandbox.stub(Logger.getInstance(), 'warn');

      await service.unsyncBundle('hostile');

      for (const [name, file] of Object.entries(sentinels)) {
        if (name !== 'linked' || POSIX) {
          assert.ok(fs.existsSync(file), `${name} sentinel survives`);
        }
      }
      const warned = warn.getCalls().map((call) => call.args.map(String).join(' ')).join('\n');
      for (const file of files) {
        assert.ok(warned.includes(file.path), `a warning names ${file.path}`);
      }
    });

    test('rethrows a lockfile removal failure', async () => {
      await service.syncBundle(DEMO_PLUGIN_ID, '', { commitMode: 'commit', install: await installOf('prompt') });
      sandbox.stub(LockfileManager.prototype, 'remove').rejects(new Error('disk full'));

      await assert.rejects(service.unsyncBundle(DEMO_PLUGIN_ID), { message: 'disk full' });
    });

    test('changes nothing for a bundle that is not installed', async () => {
      assert.strictEqual((await service.unsyncBundle('absent'))?.removed.length ?? 0, 0);
      assert.deepStrictEqual(fs.readdirSync(workspaceRoot), []);
    });
  });

  suite('switchCommitMode', () => {
    /**
     * Seed a repository entry as the CLI writes it for a vscode target, with its files under `.github/`.
     * @param commitMode - Lockfile the entry is written to.
     * @returns The entry.
     */
    const seedCliEntry = (commitMode: RepositoryCommitMode) => {
      writeWorkspaceFile('.github/plugins/demo-plugin/plugin.json', '{"name":"demo-plugin"}');
      writeWorkspaceFile('.github/skills/helper/SKILL.md', '# Helper');
      writeWorkspaceFile('.github/prompts/hello.prompt.md', '# Hello');
      const entry = {
        version: '1.0.0',
        sourceId: 'local-demo',
        sourceType: 'local',
        installedAt: '2024-01-01T00:00:00.000Z',
        targetType: 'vscode',
        files: [
          { path: 'plugins/demo-plugin/plugin.json', checksum: sha256('{"name":"demo-plugin"}') },
          { path: 'prompts/hello.prompt.md', checksum: sha256('# Hello'), installedPath: 'prompts/hello.prompt.md' },
          { path: 'skills/helper/SKILL.md', checksum: sha256('# Helper') }
        ]
      };
      fs.writeFileSync(path.join(workspaceRoot, lockfileName(commitMode)), JSON.stringify({
        $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
        version: '2.0.0',
        generatedAt: new Date().toISOString(),
        generatedBy: 'ai-primitives-hub-cli@test',
        bundles: { 'demo-plugin': entry },
        sources: { 'local-demo': { type: 'local', url: 'local:local-demo' } }
      }, null, 2));
      return entry;
    };
    const readLockfileBundle = (name: string) => {
      const file = path.join(workspaceRoot, name);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).bundles['demo-plugin'] : undefined;
    };

    test('switching to local-only moves the entry and excludes exactly its recorded files and the local lockfile', async () => {
      createGitDirectory();
      const entry = seedCliEntry('commit');
      writeWorkspaceFile('.github/prompts/unrelated.prompt.md', '# Not from this bundle');
      writeWorkspaceFile('.github/copilot-instructions.md', '# Repository instructions');

      await service.switchCommitMode('demo-plugin', 'local-only');

      assert.deepStrictEqual(readLockfileBundle('prompt-registry.local.lock.json'), entry, 'the entry moves with targetType intact');
      assert.strictEqual(readLockfileBundle('prompt-registry.lock.json'), undefined);
      assert.deepStrictEqual(excludedLines(), [
        '.github/plugins/demo-plugin/plugin.json',
        '.github/prompts/hello.prompt.md',
        '.github/skills/helper/SKILL.md',
        'prompt-registry.local.lock.json'
      ]);
    });

    test('switching back to commit removes the recorded files and a legacy skill directory line from git exclude', async () => {
      createGitDirectory();
      const entry = seedCliEntry('local-only');
      fs.writeFileSync(path.join(workspaceRoot, '.git', 'info', 'exclude'), [
        '# Prompt Registry (local)',
        '.github/plugins/demo-plugin/plugin.json',
        '.github/prompts/hello.prompt.md',
        '.github/skills/helper',
        'prompt-registry.local.lock.json',
        ''
      ].join('\n'));

      await service.switchCommitMode('demo-plugin', 'commit');

      assert.deepStrictEqual(readLockfileBundle('prompt-registry.lock.json'), entry, 'the entry moves with targetType intact');
      assert.ok(!fs.existsSync(path.join(workspaceRoot, 'prompt-registry.local.lock.json')));
      assert.deepStrictEqual(excludedLines(), []);
    });

    test('switching a bundle that is not installed changes nothing', async () => {
      createGitDirectory();

      await service.switchCommitMode('absent', 'local-only');

      assert.strictEqual(readGitExclude(), null);
      assert.ok(!fs.existsSync(path.join(workspaceRoot, 'prompt-registry.local.lock.json')));
    });
  });
});
