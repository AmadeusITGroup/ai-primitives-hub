/**
 * `uninstall` command tests (symmetric with install.test.ts's local
 * `--from` mode — no network required).
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since uninstall does real file removals + lockfile IO.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  InstallCommand,
} from '../../src/commands/install';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  UninstallCommand,
} from '../../src/commands/uninstall';
import {
  runCommand,
} from '../../src/framework';
import {
  createGovernedReleaseArchive,
  writeReleaseArchive,
} from '../fixtures/release-archives';

const COMMAND_CLASSES = [
  TargetAddCommand,
  InstallCommand,
  UninstallCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('uninstall command', () => {
  let workspace: string;
  let bundleDir: string;
  let targetDir: string;
  const installedFile = (): string => path.join(targetDir, 'prompts', 'hello.prompt.md');

  const run = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: {
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
      }
    }
  });

  const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

  const installSkillKnowledgeRoundtrip = async (
    targetName: string,
    targetType: 'vscode' | 'kiro',
    hostRootName: '.github' | '.kiro'
  ): Promise<void> => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeSkillKnowledge: true }));
    expect((await run([
      'target', 'add', targetName, '--type', targetType, '--scope', 'repository',
      '--workspace-root', workspace, '-o', 'json'
    ])).exitCode).toBe(0);
    const installResult = await run(['install', 'local-foo', '--from', bundleDir, '--target', targetName, '-o', 'json']);
    expect(installResult.exitCode).toBe(0);

    const skillRoot = path.join(workspace, hostRootName, 'skills', 'knowledge-skill');
    const skillFile = path.join(skillRoot, 'SKILL.md');
    const sidecarFile = path.join(skillRoot, 'knowledge', 'guide.md');
    const standaloneKnowledge = path.join(
      workspace, hostRootName, 'knowledge', 'skills', 'knowledge-skill', 'knowledge', 'guide.md'
    );
    const unrelatedFile = path.join(workspace, hostRootName, 'skills', 'unrelated', 'SKILL.md');
    await expect(readFile(skillFile, 'utf8')).resolves.toContain('Knowledge Skill');
    await expect(readFile(sidecarFile, 'utf8')).resolves.toContain('Embedded skill knowledge');
    await expect(readFile(standaloneKnowledge, 'utf8')).resolves.toContain('Embedded skill knowledge');
    await mkdir(path.dirname(unrelatedFile), { recursive: true });
    await writeFile(unrelatedFile, '# Unrelated skill');

    const lockfilePath = parseJson<{ lockfile: string }>(installResult.stdout).data.lockfile;
    const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    const paths = lockfile.bundles['local-foo'].files.map((file) => file.path);
    expect(paths).toContain('skills/knowledge-skill/SKILL.md');
    expect(paths).toContain('skills/knowledge-skill/knowledge/guide.md');
    expect(paths).toContain(`${hostRootName}/knowledge/skills/knowledge-skill/knowledge/guide.md`);

    const uninstallResult = await run(['uninstall', '--bundle', 'local-foo', '--target', targetName, '-o', 'json']);
    expect(uninstallResult.exitCode).toBe(0);
    await expect(readFile(skillFile, 'utf8')).rejects.toThrow();
    await expect(readFile(sidecarFile, 'utf8')).rejects.toThrow();
    await expect(readFile(standaloneKnowledge, 'utf8')).rejects.toThrow();
    await expect(readFile(unrelatedFile, 'utf8')).resolves.toBe('# Unrelated skill');
    await expect(readFile(lockfilePath, 'utf8')).rejects.toThrow();
  };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-uninstall-test-'));
    bundleDir = path.join(workspace, 'bundle');
    targetDir = path.join(workspace, 'target');

    await mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, 'deployment-manifest.yml'),
      'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
    );
    await writeFile(path.join(bundleDir, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n');

    expect((await run([
      'target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json'
    ])).exitCode).toBe(0);
    expect((await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('uninstalls an installed bundle: removes files and clears the lockfile entry', async () => {
    const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ removed: string[]; lockfile: string }>(result.stdout);
    expect(envelope.data.removed.length).toBeGreaterThan(0);

    await expect(readFile(installedFile(), 'utf8')).rejects.toThrow();

    const lockContent = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as { bundles: Record<string, unknown> };
    expect(lockContent.bundles).toEqual({});
  });

  it('uninstalls a governed bundle using installable-only lockfile paths', async () => {
    const initialUninstall = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    expect(initialUninstall.exitCode).toBe(0);
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo' }));

    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);
    await expect(readFile(installedFile(), 'utf8')).resolves.toContain('Hello Prompt');

    const uninstallResult = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    expect(uninstallResult.exitCode).toBe(0);
    await expect(readFile(installedFile(), 'utf8')).rejects.toThrow();

    const envelope = parseJson<{ lockfile: string }>(uninstallResult.stdout);
    const lockContent = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as {
      bundles: Record<string, unknown>;
    };
    expect(lockContent.bundles).toEqual({});
  });

  it('uninstalls nested knowledge by its canonical user-scope lockfile path', async () => {
    const initialUninstall = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    expect(initialUninstall.exitCode).toBe(0);
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    const relativePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    const unrelatedPath = path.join(targetDir, 'knowledge', 'unrelated.md');
    await mkdir(path.dirname(unrelatedPath), { recursive: true });
    await writeFile(unrelatedPath, '# Unrelated');

    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);
    await expect(readFile(path.join(targetDir, 'knowledge', relativePath), 'utf8')).resolves.toContain('SBB B2P');

    const uninstallResult = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);

    expect(uninstallResult.exitCode).toBe(0);
    await expect(readFile(path.join(targetDir, 'knowledge', relativePath), 'utf8')).rejects.toThrow();
    await expect(readFile(unrelatedPath, 'utf8')).resolves.toBe('# Unrelated');
  });

  it.skipIf(process.platform === 'win32')('preserves the user lockfile when knowledge removal escapes through a parent symlink', async () => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);
    const installEnvelope = parseJson<{ lockfile: string }>(installResult.stdout);

    const outside = path.join(workspace, 'outside-knowledge');
    const linkedParent = path.join(targetDir, 'knowledge', 'specifications');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'victim.md'), '# Outside');
    await rm(path.join(targetDir, 'knowledge'), { recursive: true, force: true });
    await mkdir(path.dirname(linkedParent), { recursive: true });
    await symlink(outside, linkedParent, 'dir');

    const uninstallResult = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);

    expect(uninstallResult.exitCode).not.toBe(0);
    const lockfile = JSON.parse(await readFile(installEnvelope.data.lockfile, 'utf8')) as {
      bundles: Record<string, unknown>;
    };
    expect(lockfile.bundles['local-foo']).toBeDefined();
    await expect(readFile(path.join(outside, 'victim.md'), 'utf8')).resolves.toBe('# Outside');
  });

  it('round-trips embedded and standalone skill knowledge for Copilot repository installs', async () => {
    await installSkillKnowledgeRoundtrip('copilot-repository', 'vscode', '.github');
  });

  it('round-trips embedded and standalone skill knowledge for Kiro repository installs', async () => {
    await installSkillKnowledgeRoundtrip('kiro-repository', 'kiro', '.kiro');
  });

  it('uninstalls ordinary skill and prompt files below a directory named knowledge', async () => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    const bundleId = 'local-foo';
    const files = new Map([
      ['deployment-manifest.yml', new TextEncoder().encode(`id: ${bundleId}
version: 1.0.0
name: Knowledge Names
prompts:
  - id: knowledge-skill
    file: skills/knowledge/SKILL.md
    type: skill
  - id: knowledge-prompt
    file: prompts/knowledge/guide.md
    type: prompt
`)],
      ['skills/knowledge/SKILL.md', new TextEncoder().encode('# Skill')],
      ['prompts/knowledge/guide.md', new TextEncoder().encode('# Prompt')]
    ]);
    await writeReleaseArchive(bundleDir, files);
    const installResult = await run([
      'install', bundleId, '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);
    const skillFile = path.join(targetDir, 'skills', 'knowledge', 'SKILL.md');
    const promptFile = path.join(targetDir, 'prompts', 'knowledge', 'guide.md');
    await expect(readFile(skillFile, 'utf8')).resolves.toBe('# Skill');
    await expect(readFile(promptFile, 'utf8')).resolves.toBe('# Prompt');

    const result = await run(['uninstall', '--bundle', bundleId, '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode, result.stderr).toBe(0);
    await expect(readFile(skillFile, 'utf8')).rejects.toThrow();
    await expect(readFile(promptFile, 'utf8')).rejects.toThrow();
  });

  it('round-trips legacy dual items/prompts knowledge with a Copilot repository install', async () => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    const knowledgePath = 'specifications/items-guide.md';
    await writeReleaseArchive(bundleDir, new Map([
      ['deployment-manifest.yml', new TextEncoder().encode(`id: local-foo
version: 1.0.0
name: Legacy Dual
prompts:
  - id: shared-prompt
    file: prompts/shared.md
    type: prompt
  - id: guide-prompt
    file: prompts/guide.md
    type: prompt
items:
  - path: ${knowledgePath}
    kind: knowledge
  - id: duplicate-prompt
    path: prompts/shared.md
    kind: prompt
`)],
      ['prompts/shared.md', new TextEncoder().encode('# Shared prompt')],
      ['prompts/guide.md', new TextEncoder().encode('# Guide prompt')],
      [knowledgePath, new TextEncoder().encode('# Item knowledge')]
    ]));
    expect((await run([
      'target', 'add', 'copilot-repository', '--type', 'vscode', '--scope', 'repository',
      '--workspace-root', workspace, '-o', 'json'
    ])).exitCode).toBe(0);

    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot-repository', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);
    const sharedPrompt = path.join(workspace, '.github', 'copilot', 'prompts', 'shared.md');
    const guidePrompt = path.join(workspace, '.github', 'copilot', 'prompts', 'guide.md');
    const knowledgeFile = path.join(workspace, '.github', 'knowledge', knowledgePath);
    await expect(readFile(sharedPrompt, 'utf8')).resolves.toBe('# Shared prompt');
    await expect(readFile(guidePrompt, 'utf8')).resolves.toBe('# Guide prompt');
    await expect(readFile(knowledgeFile, 'utf8')).resolves.toBe('# Item knowledge');
    const lockfilePath = parseJson<{ lockfile: string }>(installResult.stdout).data.lockfile;
    const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    const trackedPaths = lockfile.bundles['local-foo'].files.map((file) => file.path);
    expect(trackedPaths.filter((filePath) => filePath === 'prompts/shared.md')).toHaveLength(1);
    expect(trackedPaths).toContain('prompts/guide.md');
    expect(trackedPaths).toContain(`.github/knowledge/${knowledgePath}`);

    const unrelatedFile = path.join(workspace, '.github', 'knowledge', 'unrelated.md');
    await writeFile(unrelatedFile, '# Unrelated');
    expect((await run([
      'uninstall', '--bundle', 'local-foo', '--target', 'copilot-repository', '-o', 'json'
    ])).exitCode).toBe(0);
    await expect(readFile(sharedPrompt, 'utf8')).rejects.toThrow();
    await expect(readFile(guidePrompt, 'utf8')).rejects.toThrow();
    await expect(readFile(knowledgeFile, 'utf8')).rejects.toThrow();
    await expect(readFile(unrelatedFile, 'utf8')).resolves.toBe('# Unrelated');
  });

  it('round-trips legacy dual prompts and items knowledge through Copilot repository scope', async () => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    const promptPath = 'prompts/shared.md';
    const promptKnowledgePath = 'specifications/prompts-guide.md';
    const itemsKnowledgePath = 'specifications/items-guide.md';
    const duplicateKnowledgePath = 'specifications/duplicate-guide.md';
    const agentPath = 'agents/review.md';
    const files = new Map([
      ['deployment-manifest.yml', new TextEncoder().encode(`id: local-foo
version: 1.0.0
name: Legacy Dual
prompts:
  - id: shared-prompt
    file: ${promptPath}
    type: prompt
  - id: prompt-agent-wins
    file: ${agentPath}
    type: chat-mode
  - id: prompt-guide
    file: ${promptKnowledgePath}
    type: knowledge
  - id: prompt-wins
    file: ${duplicateKnowledgePath}
    type: knowledge
items:
  - path: ${itemsKnowledgePath}
    kind: knowledge
  - id: duplicate-prompt
    path: ${promptPath}
    kind: prompt
  - id: item-agent-loses
    path: ${agentPath}
    kind: chatmode
  - id: item-loses
    path: ${duplicateKnowledgePath}
    kind: knowledge
`)],
      [promptPath, new TextEncoder().encode('# Shared prompt')],
      [agentPath, new TextEncoder().encode('# Review agent')],
      [promptKnowledgePath, new TextEncoder().encode('# Prompt knowledge')],
      [itemsKnowledgePath, new TextEncoder().encode('# Items knowledge')],
      [duplicateKnowledgePath, new TextEncoder().encode('# Duplicate knowledge')]
    ]);
    await writeReleaseArchive(bundleDir, files);
    expect((await run([
      'target', 'add', 'copilot-repository', '--type', 'vscode', '--scope', 'repository',
      '--workspace-root', workspace, '-o', 'json'
    ])).exitCode).toBe(0);

    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot-repository', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);
    const sharedTarget = path.join(workspace, '.github', 'copilot', 'prompts', 'shared.md');
    const agentTarget = path.join(workspace, '.github', 'copilot', 'agents', 'review.md');
    const promptKnowledgeTarget = path.join(workspace, '.github', 'knowledge', promptKnowledgePath);
    const itemsKnowledgeTarget = path.join(workspace, '.github', 'knowledge', itemsKnowledgePath);
    const duplicateKnowledgeTarget = path.join(workspace, '.github', 'knowledge', duplicateKnowledgePath);
    await expect(readFile(sharedTarget, 'utf8')).resolves.toBe('# Shared prompt');
    await expect(readFile(agentTarget, 'utf8')).resolves.toBe('# Review agent');
    await expect(readFile(promptKnowledgeTarget, 'utf8')).resolves.toBe('# Prompt knowledge');
    await expect(readFile(itemsKnowledgeTarget, 'utf8')).resolves.toBe('# Items knowledge');
    await expect(readFile(duplicateKnowledgeTarget, 'utf8')).resolves.toBe('# Duplicate knowledge');
    const lockfilePath = parseJson<{ lockfile: string }>(installResult.stdout).data.lockfile;
    const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    const trackedPaths = lockfile.bundles['local-foo'].files.map((file) => file.path);
    expect(trackedPaths.filter((filePath) => filePath === promptPath)).toHaveLength(1);
    expect(trackedPaths.filter((filePath) => filePath === agentPath)).toHaveLength(1);
    expect(trackedPaths).toContain(`.github/knowledge/${promptKnowledgePath}`);
    expect(trackedPaths).toContain(`.github/knowledge/${itemsKnowledgePath}`);
    expect(trackedPaths).toContain(`.github/knowledge/${duplicateKnowledgePath}`);

    const unrelatedFile = path.join(workspace, '.github', 'knowledge', 'unrelated.md');
    await writeFile(unrelatedFile, '# Unrelated');
    expect((await run([
      'uninstall', '--bundle', 'local-foo', '--target', 'copilot-repository', '-o', 'json'
    ])).exitCode).toBe(0);
    await expect(readFile(sharedTarget, 'utf8')).rejects.toThrow();
    await expect(readFile(agentTarget, 'utf8')).rejects.toThrow();
    await expect(readFile(promptKnowledgeTarget, 'utf8')).rejects.toThrow();
    await expect(readFile(itemsKnowledgeTarget, 'utf8')).rejects.toThrow();
    await expect(readFile(duplicateKnowledgeTarget, 'utf8')).rejects.toThrow();
    await expect(readFile(unrelatedFile, 'utf8')).resolves.toBe('# Unrelated');
  });

  it('uninstalls Kiro user knowledge from its configured user base', async () => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    const targetResult = await run(['target', 'add', 'kiro-user', '--type', 'kiro', '--path', targetDir, '-o', 'json']);
    expect(targetResult.exitCode).toBe(0);
    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'kiro-user', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);
    const relativePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    const knowledgePath = path.join(targetDir, 'knowledge', relativePath);
    await expect(readFile(knowledgePath, 'utf8')).resolves.toContain('SBB B2P');

    const uninstallResult = await run(['uninstall', '--bundle', 'local-foo', '--target', 'kiro-user', '-o', 'json']);

    expect(uninstallResult.exitCode).toBe(0);
    await expect(readFile(knowledgePath, 'utf8')).rejects.toThrow();
  });

  it('uninstalls Kiro repository knowledge from its physical lockfile path', async () => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    const targetResult = await run([
      'target', 'add', 'kiro-repository', '--type', 'kiro', '--scope', 'repository',
      '--workspace-root', workspace, '-o', 'json'
    ]);
    expect(targetResult.exitCode).toBe(0);

    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'kiro-repository', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);
    const relativePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    await expect(readFile(path.join(workspace, '.kiro', 'knowledge', relativePath), 'utf8')).resolves.toContain('SBB B2P');

    const uninstallResult = await run([
      'uninstall', '--bundle', 'local-foo', '--target', 'kiro-repository', '-o', 'json'
    ]);

    expect(uninstallResult.exitCode).toBe(0);
    await expect(readFile(path.join(workspace, '.kiro', 'knowledge', relativePath), 'utf8')).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('rejects a foreign GitHub knowledge path for a Kiro lockfile', async () => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    const targetResult = await run([
      'target', 'add', 'kiro-repository', '--type', 'kiro', '--scope', 'repository',
      '--workspace-root', workspace, '-o', 'json'
    ]);
    expect(targetResult.exitCode).toBe(0);
    expect((await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'kiro-repository', '-o', 'json'
    ])).exitCode).toBe(0);

    const lockPath = path.join(workspace, 'prompt-registry.lock.json');
    const lockfile = JSON.parse(await readFile(lockPath, 'utf8')) as {
      bundles: Record<string, { files: { path: string; checksum: string }[] }>;
    };
    const sourcePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    const entry = lockfile.bundles['local-foo'];
    const knowledgeEntry = entry.files.find((file) => file.path === `.kiro/knowledge/${sourcePath}`);
    expect(knowledgeEntry).toBeDefined();
    if (knowledgeEntry === undefined) {
      throw new Error('expected the Kiro knowledge path in the lockfile');
    }
    knowledgeEntry.path = `.github/knowledge/${sourcePath}`;
    await writeFile(lockPath, JSON.stringify(lockfile, null, 2));

    const result = await run([
      'uninstall', '--bundle', 'local-foo', '--target', 'kiro-repository', '--scope', 'repository', '-o', 'json'
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(await readFile(lockPath, 'utf8')).bundles['local-foo']).toBeDefined();
    await expect(readFile(path.join(workspace, '.kiro', 'knowledge', sourcePath), 'utf8')).resolves.toContain('SBB B2P');
    await expect(readFile(path.join(workspace, '.kiro', 'steering', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
  });

  it('uses the physical knowledge lock path and actual local-only mode during uninstall', async () => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));

    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot',
      '--scope', 'repository', '--commit-mode', 'local-only', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);
    const relativePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    const excludePath = path.join(workspace, '.git', 'info', 'exclude');
    await expect(readFile(excludePath, 'utf8')).resolves.toContain(`.github/knowledge/${relativePath}`);

    const uninstallResult = await run([
      'uninstall', '--bundle', 'local-foo', '--target', 'copilot', '--scope', 'repository',
      '--commit-mode', 'commit', '-o', 'json'
    ]);

    expect(uninstallResult.exitCode).toBe(0);
    await expect(readFile(path.join(workspace, '.github', 'knowledge', relativePath), 'utf8')).rejects.toThrow();
    await expect(readFile(excludePath, 'utf8')).resolves.not.toContain(`.github/knowledge/${relativePath}`);
  });

  it('is a warning no-op (exit 0) when the bundle is not installed', async () => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ reason: string }>(result.stdout);
    expect(envelope.status).toBe('warning');
    expect(envelope.data.reason).toBe('not found in lockfile');
  });

  it('dry-run: previews removal without deleting files', async () => {
    const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '--dry-run', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ dryRun: boolean; files: string[] }>(result.stdout);
    expect(envelope.data.dryRun).toBe(true);
    expect(envelope.data.files.length).toBeGreaterThan(0);

    const stillInstalled = await readFile(installedFile(), 'utf8');
    expect(stillInstalled).toContain('Hello Prompt');
  });

  it('round-trips repository scope: removes files from the same layout used by install', async () => {
    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot',
      '--scope', 'repository', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);

    const repositoryFile = path.join(workspace, '.github', 'copilot', 'prompts', 'hello.prompt.md');
    await expect(readFile(repositoryFile, 'utf8')).resolves.toContain('Hello Prompt');

    const uninstallResult = await run([
      'uninstall', '--bundle', 'local-foo', '--target', 'copilot',
      '--scope', 'repository', '-o', 'json'
    ]);
    expect(uninstallResult.exitCode).toBe(0);
    const envelope = parseJson<{ removed: string[]; lockfile: string }>(uninstallResult.stdout);
    expect(envelope.data.removed.length).toBeGreaterThan(0);
    await expect(readFile(repositoryFile, 'utf8')).rejects.toThrow();
    await expect(readFile(envelope.data.lockfile, 'utf8')).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32').each([
    ['bundle', (_lockPath: string) => ['--bundle', 'local-foo']],
    ['all', (_lockPath: string) => ['--all']],
    ['lockfile', (lockPath: string) => ['--lockfile', lockPath]]
  ])('refuses an outside symlink without discarding the repository lockfile (%s)', async (_mode, args) => {
    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot',
      '--scope', 'repository', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);

    const lockPath = path.join(workspace, 'prompt-registry.lock.json');
    const lockfile = JSON.parse(await readFile(lockPath, 'utf8')) as {
      bundles: Record<string, { files: { path: string; checksum: string }[] }>;
    };
    const outside = path.join(path.dirname(workspace), `${path.basename(workspace)}-outside`);
    try {
      await mkdir(outside);
      const victim = path.join(outside, 'victim.md');
      await writeFile(victim, '# Do not delete');
      await symlink(outside, path.join(workspace, '.github', 'copilot', 'prompts', 'linked'), 'dir');
      // The unsafe entry comes after an installed file: check the entire
      // bundle before deleting even the first safe entry.
      lockfile.bundles['local-foo'].files.push({ path: 'prompts/linked/victim.md', checksum: 'tracked' });
      await writeFile(lockPath, JSON.stringify(lockfile, null, 2));

      const result = await run(['uninstall', ...args(lockPath), '--target', 'copilot', '--scope', 'repository', '-o', 'json']);

      expect(result.exitCode).not.toBe(0);
      await expect(readFile(victim, 'utf8')).resolves.toBe('# Do not delete');
      await expect(readFile(installedFile().replace(targetDir, path.join(workspace, '.github', 'copilot')), 'utf8'))
        .resolves.toContain('Hello Prompt');
      expect((JSON.parse(await readFile(lockPath, 'utf8')) as typeof lockfile).bundles['local-foo']).toBeDefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('--all removes every installed bundle for the target', async () => {
    const result = await run(['uninstall', '--all', '--target', 'copilot', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ uninstalled: number }>(result.stdout);
    expect(envelope.data.uninstalled).toBe(1);

    await expect(readFile(installedFile(), 'utf8')).rejects.toThrow();
  });

  it('fails with exit 1 when neither --bundle, --lockfile, nor --all is given (and no lockfile is discoverable)', async () => {
    const freshWorkspace = await mkdtemp(path.join(os.tmpdir(), 'cli-uninstall-test-fresh-'));
    try {
      const freshTargetDir = path.join(freshWorkspace, 'target');
      await mkdir(freshTargetDir, { recursive: true });
      const freshRun = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
        commandClasses: COMMAND_CLASSES,
        context: {
          cwd: freshWorkspace,
          fs: new NodeFileSystem(),
          env: {
            HOME: freshWorkspace,
            USERPROFILE: freshWorkspace,
            XDG_CONFIG_HOME: path.join(freshWorkspace, 'xdg-config'),
            XDG_CACHE_HOME: path.join(freshWorkspace, 'xdg-cache')
          }
        }
      });
      expect((await freshRun([
        'target', 'add', 'copilot', '--type', 'copilot-cli', '--path', freshTargetDir, '-o', 'json'
      ])).exitCode).toBe(0);

      const result = await freshRun(['uninstall', '--target', 'copilot', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    } finally {
      await rm(freshWorkspace, { recursive: true, force: true });
    }
  });
});
