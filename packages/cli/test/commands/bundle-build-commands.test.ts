/**
 * Bundle build / manifest / collection-validate / skill-validate / version-compute
 * command tests.
 *
 * Coverage goals:
 *  1. CLI option recognition (no "Unsupported option name" from clipanion).
 *  2. repo-slug fallback logic: --repo-slug > GITHUB_REPOSITORY > cwd basename.
 *  3. collection validate / skill validate / collection list / collection affected
 *     option recognition.
 *  4. version compute option recognition.
 *  5. Error paths: missing --version, missing collection file, invalid collection id.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  BundleBuildCommand,
} from '../../src/commands/bundle-build';
import {
  BundleManifestCommand,
} from '../../src/commands/bundle-manifest';
import {
  CollectionAffectedCommand,
} from '../../src/commands/collection-affected';
import {
  CollectionListCommand,
} from '../../src/commands/collection-list';
import {
  CollectionValidateCommand,
} from '../../src/commands/collection-validate';
import {
  SkillValidateCommand,
} from '../../src/commands/skill-validate';
import {
  VersionComputeCommand,
} from '../../src/commands/version-compute';
import {
  runCommand,
} from '../../src/framework';
import {
  createNodeFsAdapter,
} from '../helpers/node-fs-adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseContext = () => ({
  cwd: '/tmp',
  fs: createNodeFsAdapter(),
  env: {} as Record<string, string>
});

// ---------------------------------------------------------------------------
// 1. CLI option recognition — bundle build
// ---------------------------------------------------------------------------

describe('bundle build - CLI option recognition', () => {
  it('recognizes -o/--output option', async () => {
    const { stderr } = await runCommand(
      ['bundle', 'build', '-o', 'json'],
      { commandClasses: [BundleBuildCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --collection-file option', async () => {
    const { stderr } = await runCommand(
      ['bundle', 'build', '--collection-file', 'collections/foo.collection.yml'],
      { commandClasses: [BundleBuildCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --version option', async () => {
    const { stderr } = await runCommand(
      ['bundle', 'build', '--version', '1.0.0'],
      { commandClasses: [BundleBuildCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --out-dir option', async () => {
    const { stderr } = await runCommand(
      ['bundle', 'build', '--out-dir', 'dist'],
      { commandClasses: [BundleBuildCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --repo-slug option', async () => {
    const { stderr } = await runCommand(
      ['bundle', 'build', '--repo-slug', 'my-org-my-repo'],
      { commandClasses: [BundleBuildCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('prints help without error', async () => {
    const { exitCode, stdout } = await runCommand(
      ['bundle', 'build', '--help'],
      { commandClasses: [BundleBuildCommand], context: baseContext() }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/bundle.*build|collection-file/i);
  });
});

// ---------------------------------------------------------------------------
// 2. CLI option recognition — bundle manifest
// ---------------------------------------------------------------------------

describe('bundle manifest - CLI option recognition', () => {
  it('recognizes -o/--output option', async () => {
    const { stderr } = await runCommand(
      ['bundle', 'manifest', '-o', 'json'],
      { commandClasses: [BundleManifestCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --version option', async () => {
    const { stderr } = await runCommand(
      ['bundle', 'manifest', '--version', '2.0.0'],
      { commandClasses: [BundleManifestCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --collection-file option', async () => {
    const { stderr } = await runCommand(
      ['bundle', 'manifest', '--collection-file', 'collections/foo.collection.yml'],
      { commandClasses: [BundleManifestCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --out-file option', async () => {
    const { stderr } = await runCommand(
      ['bundle', 'manifest', '--out-file', 'dist/deployment-manifest.yml'],
      { commandClasses: [BundleManifestCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });
});

// ---------------------------------------------------------------------------
// 3. CLI option recognition — collection validate
// ---------------------------------------------------------------------------

describe('collection validate - CLI option recognition', () => {
  it('recognizes -o/--output option', async () => {
    const { stderr } = await runCommand(
      ['collection', 'validate', '-o', 'json'],
      { commandClasses: [CollectionValidateCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --markdown-path option', async () => {
    const { stderr } = await runCommand(
      ['collection', 'validate', '--markdown-path', '/tmp/report.md'],
      { commandClasses: [CollectionValidateCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --collection-file option (repeatable)', async () => {
    const { stderr } = await runCommand(
      ['collection', 'validate', '--collection-file', 'a.collection.yml', '--collection-file', 'b.collection.yml'],
      { commandClasses: [CollectionValidateCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --verbose option', async () => {
    const { stderr } = await runCommand(
      ['collection', 'validate', '--verbose'],
      { commandClasses: [CollectionValidateCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });
});

// ---------------------------------------------------------------------------
// 4. CLI option recognition — collection list
// ---------------------------------------------------------------------------

describe('collection list - CLI option recognition', () => {
  it('recognizes -o/--output option', async () => {
    const { stderr } = await runCommand(
      ['collection', 'list', '-o', 'json'],
      { commandClasses: [CollectionListCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });
});

// ---------------------------------------------------------------------------
// 5. CLI option recognition — collection affected
// ---------------------------------------------------------------------------

describe('collection affected - CLI option recognition', () => {
  it('recognizes -o/--output option', async () => {
    const { stderr } = await runCommand(
      ['collection', 'affected', '-o', 'json'],
      { commandClasses: [CollectionAffectedCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --changed-path option (repeatable)', async () => {
    const { stderr } = await runCommand(
      ['collection', 'affected', '--changed-path', 'collections/foo.collection.yml', '--changed-path', 'prompts/bar.md'],
      { commandClasses: [CollectionAffectedCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });
});

// ---------------------------------------------------------------------------
// 6. CLI option recognition — skill validate
// ---------------------------------------------------------------------------

describe('skill validate - CLI option recognition', () => {
  it('recognizes -o/--output option', async () => {
    const { stderr } = await runCommand(
      ['skill', 'validate', '-o', 'json'],
      { commandClasses: [SkillValidateCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --skills-dir option', async () => {
    const { stderr } = await runCommand(
      ['skill', 'validate', '--skills-dir', 'custom-skills'],
      { commandClasses: [SkillValidateCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --verbose option', async () => {
    const { stderr } = await runCommand(
      ['skill', 'validate', '--verbose'],
      { commandClasses: [SkillValidateCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });
});

// ---------------------------------------------------------------------------
// 7. CLI option recognition — version compute
// ---------------------------------------------------------------------------

describe('version compute - CLI option recognition', () => {
  it('recognizes -o/--output option', async () => {
    const { stderr } = await runCommand(
      ['version', 'compute', '-o', 'json'],
      { commandClasses: [VersionComputeCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });

  it('recognizes --collection-file option', async () => {
    const { stderr } = await runCommand(
      ['version', 'compute', '--collection-file', 'collections/foo.collection.yml'],
      { commandClasses: [VersionComputeCommand], context: baseContext() }
    );
    expect(stderr).not.toMatch(/Unsupported option name/);
  });
});

// ---------------------------------------------------------------------------
// 8. repo-slug fallback integration tests (uses real tmp filesystem)
// ---------------------------------------------------------------------------

describe('bundle build - repo-slug fallback', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-bundle-test-'));
    // Create minimal collection structure
    const collectionsDir = path.join(tmpDir, 'collections');
    await fs.mkdir(collectionsDir);
    await fs.writeFile(
      path.join(collectionsDir, 'hello.collection.yml'),
      [
        'id: hello',
        'name: Hello Collection',
        'description: Test collection',
        'items:',
        '  - path: prompts/hello.prompt.md',
        '    kind: prompt'
      ].join('\n')
    );
    const promptsDir = path.join(tmpDir, 'prompts');
    await fs.mkdir(promptsDir);
    await fs.writeFile(
      path.join(promptsDir, 'hello.prompt.md'),
      '# Hello Prompt\n\nA test prompt.\n'
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('succeeds with explicit --repo-slug (no env var needed)', async () => {
    const { exitCode, stdout } = await runCommand(
      [
        'bundle', 'build',
        '--collection-file', 'collections/hello.collection.yml',
        '--version', '1.0.0',
        '--repo-slug', 'acme-corp',
        '--out-dir', path.join(tmpDir, 'dist'),
        '-o', 'json'
      ],
      {
        commandClasses: [BundleBuildCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.status).toBe('ok');
    expect(data.data.bundleId).toContain('acme-corp');
    expect(data.data.bundleId).toContain('hello');
    expect(data.data.bundleId).toContain('1.0.0');
  });

  it('falls back to GITHUB_REPOSITORY env var when --repo-slug is absent', async () => {
    const { exitCode, stdout } = await runCommand(
      [
        'bundle', 'build',
        '--collection-file', 'collections/hello.collection.yml',
        '--version', '1.0.0',
        '--out-dir', path.join(tmpDir, 'dist'),
        '-o', 'json'
      ],
      {
        commandClasses: [BundleBuildCommand],
        context: {
          cwd: tmpDir,
          fs: createNodeFsAdapter(),
          env: { GITHUB_REPOSITORY: 'my-org/my-repo' }
        }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.status).toBe('ok');
    expect(data.data.bundleId).toContain('my-org-my-repo');
  });

  it('falls back to cwd directory basename when neither --repo-slug nor GITHUB_REPOSITORY is set', async () => {
    const cwdBasename = path.basename(tmpDir);
    const { exitCode, stdout } = await runCommand(
      [
        'bundle', 'build',
        '--collection-file', 'collections/hello.collection.yml',
        '--version', '1.0.0',
        '--out-dir', path.join(tmpDir, 'dist'),
        '-o', 'json'
      ],
      {
        commandClasses: [BundleBuildCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.status).toBe('ok');
    expect(data.data.bundleId).toContain(cwdBasename);
    expect(data.data.bundleId).toContain('hello');
    expect(data.data.bundleId).toContain('1.0.0');
  });

  it('--repo-slug takes precedence over GITHUB_REPOSITORY', async () => {
    const { exitCode, stdout } = await runCommand(
      [
        'bundle', 'build',
        '--collection-file', 'collections/hello.collection.yml',
        '--version', '1.0.0',
        '--repo-slug', 'explicit-slug',
        '--out-dir', path.join(tmpDir, 'dist'),
        '-o', 'json'
      ],
      {
        commandClasses: [BundleBuildCommand],
        context: {
          cwd: tmpDir,
          fs: createNodeFsAdapter(),
          env: { GITHUB_REPOSITORY: 'should-not-appear/in-bundle-id' }
        }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.status).toBe('ok');
    expect(data.data.bundleId).toContain('explicit-slug');
    expect(data.data.bundleId).not.toContain('should-not-appear');
  });

  it('produces a zip file and deployment-manifest.yml on disk', async () => {
    const outDir = path.join(tmpDir, 'dist');
    const { exitCode } = await runCommand(
      [
        'bundle', 'build',
        '--collection-file', 'collections/hello.collection.yml',
        '--version', '1.0.0',
        '--repo-slug', 'test-org',
        '--out-dir', outDir,
        '-o', 'json'
      ],
      {
        commandClasses: [BundleBuildCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    // Check manifest was written
    const manifestPath = path.join(outDir, 'hello', 'deployment-manifest.yml');
    const manifestExists = await fs.access(manifestPath).then(() => true).catch(() => false);
    expect(manifestExists).toBe(true);
    // Check zip was written
    const zipPath = path.join(outDir, 'hello', 'hello.bundle.zip');
    const zipExists = await fs.access(zipPath).then(() => true).catch(() => false);
    expect(zipExists).toBe(true);
  });

  it('reports error in JSON envelope when collection id is missing', async () => {
    const collectionsDir = path.join(tmpDir, 'collections');
    await fs.writeFile(
      path.join(collectionsDir, 'noid.collection.yml'),
      'name: No ID Collection\nitems: []\n'
    );
    const { exitCode, stdout } = await runCommand(
      [
        'bundle', 'build',
        '--collection-file', 'collections/noid.collection.yml',
        '--version', '1.0.0',
        '-o', 'json'
      ],
      {
        commandClasses: [BundleBuildCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(1);
    const data = JSON.parse(stdout);
    expect(data.status).toBe('error');
    expect(data.errors[0].code).toBe('BUNDLE.INVALID_MANIFEST');
  });
});

// ---------------------------------------------------------------------------
// 9. collection validate integration tests
// ---------------------------------------------------------------------------

describe('collection validate - integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-validate-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns FS.NOT_FOUND error in JSON when collections/ dir is missing', async () => {
    const { exitCode, stdout } = await runCommand(
      ['collection', 'validate', '-o', 'json'],
      {
        commandClasses: [CollectionValidateCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(1);
    const data = JSON.parse(stdout);
    expect(data.status).toBe('error');
    expect(data.errors[0].code).toBe('FS.NOT_FOUND');
    expect(data.errors[0].hint).toMatch(/collections/);
  });

  it('validates a well-formed collection and returns ok', async () => {
    const collectionsDir = path.join(tmpDir, 'collections');
    await fs.mkdir(collectionsDir);
    const promptsDir = path.join(tmpDir, 'prompts');
    await fs.mkdir(promptsDir);
    await fs.writeFile(path.join(promptsDir, 'hello.prompt.md'), '# Hello\n');
    await fs.writeFile(
      path.join(collectionsDir, 'valid.collection.yml'),
      [
        'id: valid-collection',
        'name: Valid',
        'description: A valid collection',
        'items:',
        '  - path: prompts/hello.prompt.md',
        '    kind: prompt'
      ].join('\n')
    );
    const { exitCode, stdout } = await runCommand(
      ['collection', 'validate', '-o', 'json'],
      {
        commandClasses: [CollectionValidateCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.status).toBe('ok');
    expect(data.data.ok).toBe(true);
    expect(data.data.totalFiles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10. collection affected - unit-level integration
// ---------------------------------------------------------------------------

describe('collection affected - integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-affected-test-'));
    const collectionsDir = path.join(tmpDir, 'collections');
    await fs.mkdir(collectionsDir);
    const promptsDir = path.join(tmpDir, 'prompts');
    await fs.mkdir(promptsDir);
    await fs.writeFile(path.join(promptsDir, 'hello.prompt.md'), '# Hello\n');
    await fs.writeFile(
      path.join(collectionsDir, 'hello.collection.yml'),
      [
        'id: hello',
        'name: Hello',
        'items:',
        '  - path: prompts/hello.prompt.md',
        '    kind: prompt'
      ].join('\n')
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports affected collection when its own file changed', async () => {
    const { exitCode, stdout } = await runCommand(
      [
        'collection', 'affected',
        '--changed-path', 'collections/hello.collection.yml',
        '-o', 'json'
      ],
      {
        commandClasses: [CollectionAffectedCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.data.affected).toHaveLength(1);
    expect(data.data.affected[0].id).toBe('hello');
  });

  it('reports affected collection when an item path changed', async () => {
    const { exitCode, stdout } = await runCommand(
      [
        'collection', 'affected',
        '--changed-path', 'prompts/hello.prompt.md',
        '-o', 'json'
      ],
      {
        commandClasses: [CollectionAffectedCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.data.affected).toHaveLength(1);
    expect(data.data.affected[0].id).toBe('hello');
  });

  it('reports no affected collections when unrelated path changed', async () => {
    const { exitCode, stdout } = await runCommand(
      [
        'collection', 'affected',
        '--changed-path', 'README.md',
        '-o', 'json'
      ],
      {
        commandClasses: [CollectionAffectedCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.data.affected).toHaveLength(0);
  });

  it('returns empty affected when no --changed-path flags provided', async () => {
    const { exitCode, stdout } = await runCommand(
      ['collection', 'affected', '-o', 'json'],
      {
        commandClasses: [CollectionAffectedCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.data.affected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. All-kinds collection: plugin + hook support
// ---------------------------------------------------------------------------

describe('all-kinds collection - plugin and hook support', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-allkinds-test-'));

    // Scaffold all directories
    for (const dir of ['collections', 'prompts', 'instructions', 'chatmodes',
      'agents', 'skills/my-skill', 'plugins/my-plugin', 'hooks']) {
      await fs.mkdir(path.join(tmpDir, dir), { recursive: true });
    }

    // Primitive files
    await fs.writeFile(path.join(tmpDir, 'prompts/hello.prompt.md'), '# Hello Prompt\n');
    await fs.writeFile(
      path.join(tmpDir, 'instructions/style.instructions.md'),
      '# Code Style\n\n> Keep lines under 100 chars.\n'
    );
    await fs.writeFile(
      path.join(tmpDir, 'chatmodes/review.chatmode.md'),
      '# Code Review Mode\n'
    );
    await fs.writeFile(path.join(tmpDir, 'agents/coder.agent.md'), '# Coder Agent\n');
    await fs.writeFile(path.join(tmpDir, 'skills/my-skill/SKILL.md'), '# My Skill\n');

    // Plugin: plugin.json with name + description
    await fs.writeFile(
      path.join(tmpDir, 'plugins/my-plugin/plugin.json'),
      JSON.stringify({ name: 'My Plugin', description: 'A test plugin', version: '1.0.0' })
    );

    // Hook: hooks.json (flat format per VS Code / GitHub Copilot spec)
    await fs.writeFile(
      path.join(tmpDir, 'hooks/format.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ type: 'command', command: './scripts/format.sh' }]
        }
      })
    );

    // Collection referencing all 7 kinds
    await fs.writeFile(
      path.join(tmpDir, 'collections/all-kinds.collection.yml'),
      [
        'id: all-kinds',
        'name: All Kinds',
        'description: Collection with every supported primitive type',
        'items:',
        '  - path: prompts/hello.prompt.md',
        '    kind: prompt',
        '  - path: instructions/style.instructions.md',
        '    kind: instruction',
        '  - path: chatmodes/review.chatmode.md',
        '    kind: chat-mode',
        '  - path: agents/coder.agent.md',
        '    kind: agent',
        '  - path: skills/my-skill/SKILL.md',
        '    kind: skill',
        '  - path: plugins/my-plugin/plugin.json',
        '    kind: plugin',
        '  - path: hooks/format.json',
        '    kind: hook'
      ].join('\n')
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('collection validate accepts all-kinds collection', async () => {
    const { exitCode, stdout } = await runCommand(
      ['collection', 'validate', '-o', 'json'],
      {
        commandClasses: [CollectionValidateCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.status).toBe('ok');
    expect(data.data.ok).toBe(true);
  });

  it('bundle manifest generates entries for plugin and hook items with JSON metadata', async () => {
    const outFile = path.join(tmpDir, 'deployment-manifest.yml');
    const { exitCode } = await runCommand(
      [
        'bundle', 'manifest',
        '--collection-file', 'collections/all-kinds.collection.yml',
        '--version', '1.0.0',
        '--out-file', outFile,
        '-o', 'json'
      ],
      {
        commandClasses: [BundleManifestCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    const manifestContent = await fs.readFile(outFile, 'utf8');
    // Plugin entry: type should be 'plugin', id derived from parent dir name
    expect(manifestContent).toContain('type: plugin');
    expect(manifestContent).toContain('my-plugin');
    // Hook entry: type should be 'hook'
    expect(manifestContent).toContain('type: hook');
    expect(manifestContent).toContain('format');
  });

  it('bundle build succeeds with all-kinds collection and produces zip + manifest', async () => {
    const outDir = path.join(tmpDir, 'dist');
    const { exitCode, stdout } = await runCommand(
      [
        'bundle', 'build',
        '--collection-file', 'collections/all-kinds.collection.yml',
        '--version', '1.0.0',
        '--repo-slug', 'test-org',
        '--out-dir', outDir,
        '-o', 'json'
      ],
      {
        commandClasses: [BundleBuildCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.status).toBe('ok');
    expect(data.data.bundleId).toContain('all-kinds');
    // Zip should exist on disk
    const zipPath = path.join(outDir, 'all-kinds', 'all-kinds.bundle.zip');
    const zipExists = await fs.access(zipPath).then(() => true).catch(() => false);
    expect(zipExists).toBe(true);
  });

  it('collection affected detects changes to plugin and hook files', async () => {
    const { exitCode: e1, stdout: s1 } = await runCommand(
      ['collection', 'affected', '--changed-path', 'plugins/my-plugin/plugin.json', '-o', 'json'],
      {
        commandClasses: [CollectionAffectedCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(e1).toBe(0);
    expect(JSON.parse(s1).data.affected[0].id).toBe('all-kinds');

    const { exitCode: e2, stdout: s2 } = await runCommand(
      ['collection', 'affected', '--changed-path', 'hooks/format.json', '-o', 'json'],
      {
        commandClasses: [CollectionAffectedCommand],
        context: { cwd: tmpDir, fs: createNodeFsAdapter(), env: {} }
      }
    );
    expect(e2).toBe(0);
    expect(JSON.parse(s2).data.affected[0].id).toBe('all-kinds');
  });
});
