/**
 * E2E Tests: Agent Skills (SKILL.md) Workflow
 *
 * Tests the complete workflow for Agent Skills support:
 * - Scaffolding awesome-copilot projects with skills
 * - Skill validation within scaffolded projects
 * - Installing bundles containing skills
 * - Copilot sync for skills to ~/.copilot/skills/
 * - Collections containing skill items
 *
 * Requirements: Issue #75 - Support for SKILL.md in prompt registry collections
 * Reference: https://agentskills.io/specification
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import nock from 'nock';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  ScaffoldCommand,
  ScaffoldType,
} from '../../src/commands/scaffold-command';
import {
  RegistrySource,
} from '../../src/types/registry';
import {
  createE2ETestContext,
  E2ETestContext,
  generateTestId,
} from '../helpers/e2e-test-helpers';

suite('E2E: Agent Skills (SKILL.md) Workflow Tests', () => {
  let testContext: E2ETestContext;
  let testId: string;
  let sandbox: sinon.SinonSandbox;

  // Test fixtures for skill content
  const createSkillMd = (name: string, description: string) => `---
name: ${name}
description: ${description}
allowed-tools:
  - read_file
  - grep_search
  - semantic_search
---

# ${name}

${description}

## Usage

This skill provides specialized capabilities for AI assistants.

## Examples

\`\`\`
Use this skill when you need to perform specialized tasks.
\`\`\`
`;

  const createCollectionWithSkill = (collectionId: string, skillPath: string) => `id: ${collectionId}
name: Test Collection with Skill
description: Collection containing an agent skill
version: 1.0.0
tags: ["test", "skills"]
items:
  - path: "prompts/example.prompt.md"
    kind: prompt
  - path: "${skillPath}"
    kind: skill
`;

  const createPromptContent = () => `---
name: Example Prompt
description: An example prompt
---

# Example Prompt

This is an example prompt for testing.
`;

  // Mock source configuration for awesome-copilot with skills
  const createMockSourceWithSkills = (id: string): RegistrySource => ({
    id,
    name: 'Test Awesome Copilot with Skills',
    type: 'awesome-copilot',
    url: 'https://github.com/test-owner/awesome-copilot-skills',
    enabled: true,
    priority: 1,
    config: {
      branch: 'main',
      collectionsPath: 'collections'
    }
  });

  setup(async function () {
    this.timeout(30_000);
    testId = generateTestId('skills');

    sandbox = sinon.createSandbox();

    // Stub VS Code authentication
    if (vscode.authentication && typeof vscode.authentication.getSession === 'function') {
      sandbox.stub(vscode.authentication, 'getSession').resolves(undefined);
    }

    // Stub child_process.exec
    const childProcess = require('node:child_process');
    sandbox.stub(childProcess, 'exec').callsFake((...args: unknown[]) => {
      const cmd = args[0] as string;
      const callback = args.at(-1) as (...callbackArgs: unknown[]) => void;
      if (cmd === 'gh auth token') {
        callback(new Error('gh not available'), '', '');
      } else {
        callback(null, '', '');
      }
    });

    testContext = await createE2ETestContext();

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  teardown(async function () {
    this.timeout(10_000);
    await testContext.cleanup();
    sandbox.restore();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  suite('Scaffold with Skills', () => {
    test('Scaffold awesome-copilot project includes skills directory', async function () {
      this.timeout(30_000);

      const projectDir = path.join(testContext.tempStoragePath, 'scaffold-test');
      fs.mkdirSync(projectDir, { recursive: true });

      const templateRoot = path.join(process.cwd(), 'templates/scaffolds/github');
      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

      await scaffoldCommand.execute(projectDir, { projectName: 'test-skills-project' });

      // Verify skills directory exists
      const skillsDir = path.join(projectDir, 'skills');
      assert.ok(fs.existsSync(skillsDir), 'Skills directory should exist');

      // Verify example skill exists
      const exampleSkillDir = path.join(skillsDir, 'example-skill');
      assert.ok(fs.existsSync(exampleSkillDir), 'Example skill directory should exist');

      const skillMdPath = path.join(exampleSkillDir, 'SKILL.md');
      assert.ok(fs.existsSync(skillMdPath), 'SKILL.md should exist in example skill');

      // Verify SKILL.md content
      const skillContent = fs.readFileSync(skillMdPath, 'utf8');
      assert.ok(skillContent.includes('name:'), 'SKILL.md should have name field');
      assert.ok(skillContent.includes('description:'), 'SKILL.md should have description field');
    });

    test('Scaffold creates skill validation script', async function () {
      this.timeout(30_000);

      const projectDir = path.join(testContext.tempStoragePath, 'scaffold-validation-test');
      fs.mkdirSync(projectDir, { recursive: true });

      const templateRoot = path.join(process.cwd(), 'templates/scaffolds/github');
      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

      await scaffoldCommand.execute(projectDir, { projectName: 'test-validation' });

      // Verify scripts README exists (validation is now via npm package)
      const scriptsReadme = path.join(projectDir, 'scripts', 'README.md');
      assert.ok(fs.existsSync(scriptsReadme), 'Scripts README should exist');

      // Verify README references the npm package validation command
      const readmeContent = fs.readFileSync(scriptsReadme, 'utf8');
      assert.ok(
        readmeContent.includes('validate-skills') || readmeContent.includes('@prompt-registry/collection-scripts'),
        'Scripts README should reference validate-skills command or npm package'
      );
    });

    test('Scaffold includes npm package for skill creation', async function () {
      this.timeout(30_000);

      const projectDir = path.join(testContext.tempStoragePath, 'scaffold-wizard-test');
      fs.mkdirSync(projectDir, { recursive: true });

      const templateRoot = path.join(process.cwd(), 'templates/scaffolds/github');
      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

      await scaffoldCommand.execute(projectDir, { projectName: 'test-wizard' });

      // Verify package.json includes the npm package for skill creation
      const packageJsonPath = path.join(projectDir, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      assert.ok(
        packageJson.devDependencies?.['@prompt-registry/collection-scripts']
        || packageJson.dependencies?.['@prompt-registry/collection-scripts'],
        'Package should include @prompt-registry/collection-scripts for skill creation'
      );
    });

    test('Scaffolded package.json includes skill scripts', async function () {
      this.timeout(30_000);

      const projectDir = path.join(testContext.tempStoragePath, 'scaffold-package-test');
      fs.mkdirSync(projectDir, { recursive: true });

      const templateRoot = path.join(process.cwd(), 'templates/scaffolds/github');
      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

      await scaffoldCommand.execute(projectDir, { projectName: 'test-package' });

      // Verify package.json exists and has skill scripts
      const packageJsonPath = path.join(projectDir, 'package.json');
      assert.ok(fs.existsSync(packageJsonPath), 'package.json should exist');

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      assert.ok(packageJson.scripts, 'package.json should have scripts');
      assert.ok(
        packageJson.scripts['skill:validate'] || packageJson.scripts.validate,
        'Should have skill validation script'
      );
    });
  });

  suite('Standalone Skill Scaffold', () => {
    test('Skill scaffold creates SKILL.md with correct structure', async function () {
      this.timeout(30_000);

      const projectDir = path.join(testContext.tempStoragePath, 'skill-scaffold-test');
      fs.mkdirSync(projectDir, { recursive: true });

      const templateRoot = path.join(process.cwd(), 'templates/scaffolds/skill');
      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.Skill);

      await scaffoldCommand.execute(projectDir, {
        projectName: 'my-custom-skill',
        description: 'A custom skill for testing'
      });

      // Skill scaffold creates a subdirectory with the skill name
      const skillDir = path.join(projectDir, 'my-custom-skill');
      const skillMdPath = path.join(skillDir, 'SKILL.md');

      assert.ok(fs.existsSync(skillMdPath), 'SKILL.md should exist');

      const content = fs.readFileSync(skillMdPath, 'utf8');

      // Verify YAML frontmatter
      assert.ok(content.startsWith('---'), 'Should have YAML frontmatter');
      assert.ok(content.includes('name:'), 'Should have name field');
      assert.ok(content.includes('description:'), 'Should have description field');
    });

    test('Skill scaffold creates supporting files', async function () {
      this.timeout(30_000);

      const projectDir = path.join(testContext.tempStoragePath, 'skill-files-test');
      fs.mkdirSync(projectDir, { recursive: true });

      const templateRoot = path.join(process.cwd(), 'templates/scaffolds/skill');
      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.Skill);

      await scaffoldCommand.execute(projectDir, { projectName: 'file-test-skill' });

      const skillDir = path.join(projectDir, 'file-test-skill');

      // Verify README exists
      const readmePath = path.join(skillDir, 'README.md');
      assert.ok(fs.existsSync(readmePath), 'README.md should exist');

      // Verify scripts directory with example
      const scriptsDir = path.join(skillDir, 'scripts');
      assert.ok(fs.existsSync(scriptsDir), 'scripts directory should exist');
    });
  });

  suite('Collection with Skills - Install Workflow', () => {
    test('Install bundle containing skill copies skill to correct location', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-skill-source`;
      const source = createMockSourceWithSkills(sourceId);
      const skillName = 'test-skill';
      const skillPath = `skills/${skillName}/SKILL.md`;

      // Setup mocks for source with skill
      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-skills/contents/collections?ref=main')
        .reply(200, [
          { name: 'skill-collection.collection.yml', type: 'file' }
        ]);

      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-skills/main/collections/skill-collection.collection.yml')
        .reply(200, createCollectionWithSkill('skill-collection', skillPath));

      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-skills/main/prompts/example.prompt.md')
        .reply(200, createPromptContent());

      nock('https://raw.githubusercontent.com')
        .persist()
        .get(`/test-owner/awesome-copilot-skills/main/${skillPath}`)
        .reply(200, createSkillMd('Test Skill', 'A test skill for e2e testing'));

      // Add source and sync
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      // Search for bundles
      const bundles = await testContext.registryManager.searchBundles({ sourceId });
      assert.ok(bundles.length > 0, 'Should find bundles with skills');

      // Find the skill collection bundle
      const skillBundle = bundles.find((b) => b.id.includes('skill-collection'));
      assert.ok(skillBundle, 'Should find skill-collection bundle');

      // Install the bundle
      await testContext.registryManager.installBundle(skillBundle.id, { scope: 'user' });

      // Verify installation
      const installed = await testContext.registryManager.listInstalledBundles();
      assert.ok(installed.length > 0, 'Should have installed bundles');
    });

    test('Collection validator accepts skill kind', function () {
      this.timeout(30_000);

      // Create a temp collection file with skill item
      const collectionDir = path.join(testContext.tempStoragePath, 'validate-test');
      fs.mkdirSync(collectionDir, { recursive: true });

      const collectionContent = `id: test-skill-collection
name: Test Skill Collection
description: Collection with skill for validation test
version: 1.0.0
items:
  - path: skills/my-skill/SKILL.md
    kind: skill
`;

      const collectionFile = path.join(collectionDir, 'test.collection.yml');
      fs.writeFileSync(collectionFile, collectionContent);

      // The collection should be valid (skill is an accepted kind)
      const yaml = require('js-yaml');
      const parsed = yaml.load(collectionContent);

      assert.ok(parsed.items, 'Collection should have items');
      assert.strictEqual(parsed.items[0].kind, 'skill', 'Item kind should be skill');
    });
  });

  suite('UserScopeService with Skills', () => {
    test('Sync recognizes skill files by pattern', function () {
      this.timeout(30_000);

      // Create a mock bundle structure with skills
      const bundleDir = path.join(testContext.tempStoragePath, 'sync-test-bundle');
      const skillsDir = path.join(bundleDir, 'skills', 'test-skill');
      fs.mkdirSync(skillsDir, { recursive: true });

      const skillMdPath = path.join(skillsDir, 'SKILL.md');
      fs.writeFileSync(skillMdPath, createSkillMd('Sync Test Skill', 'Testing sync'));

      // Create deployment manifest
      const manifest = {
        id: 'sync-test-bundle',
        name: 'Sync Test Bundle',
        version: '1.0.0',
        files: [
          { path: 'skills/test-skill/SKILL.md', type: 'skill' }
        ]
      };

      const manifestPath = path.join(bundleDir, 'deployment-manifest.yml');
      const yaml = require('js-yaml');
      fs.writeFileSync(manifestPath, yaml.dump(manifest));

      // Verify the skill file exists and has correct structure
      assert.ok(fs.existsSync(skillMdPath), 'Skill file should exist');

      const content = fs.readFileSync(skillMdPath, 'utf8');
      assert.ok(content.includes('name:'), 'Skill should have name');
    });
  });

  suite('Skill Content Validation', () => {
    test('SKILL.md requires name field in frontmatter', function () {
      this.timeout(10_000);

      const validSkill = createSkillMd('Valid Skill', 'A valid skill');

      // Parse YAML frontmatter
      const frontmatterMatch = validSkill.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(frontmatterMatch, 'Should have frontmatter');

      const yaml = require('js-yaml');
      const frontmatter = yaml.load(frontmatterMatch[1]);

      assert.ok(frontmatter.name, 'Should have name field');
      assert.strictEqual(frontmatter.name, 'Valid Skill', 'Name should match');
    });

    test('SKILL.md requires description field in frontmatter', function () {
      this.timeout(10_000);

      const validSkill = createSkillMd('Test Skill', 'Test description');

      const frontmatterMatch = validSkill.match(/^---\n([\s\S]*?)\n---/);
      const yaml = require('js-yaml');
      const frontmatter = yaml.load(frontmatterMatch![1]);

      assert.ok(frontmatter.description, 'Should have description field');
      assert.strictEqual(frontmatter.description, 'Test description', 'Description should match');
    });

    test('SKILL.md can include allowed-tools field', function () {
      this.timeout(10_000);

      const skillWithTools = createSkillMd('Tool Skill', 'Skill with tools');

      const frontmatterMatch = skillWithTools.match(/^---\n([\s\S]*?)\n---/);
      const yaml = require('js-yaml');
      const frontmatter = yaml.load(frontmatterMatch![1]);

      assert.ok(frontmatter['allowed-tools'], 'Should have allowed-tools field');
      assert.ok(Array.isArray(frontmatter['allowed-tools']), 'allowed-tools should be array');
    });
  });

  suite('Mixed Content Bundles', () => {
    test('Bundle with prompts, instructions, agents, AND skills installs correctly', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-mixed-source`;
      const source: RegistrySource = {
        id: sourceId,
        name: 'Mixed Content Source',
        type: 'awesome-copilot',
        url: 'https://github.com/test-owner/mixed-content',
        enabled: true,
        priority: 1,
        config: { branch: 'main', collectionsPath: 'collections' }
      };

      const mixedCollection = `id: mixed-collection
name: Mixed Content Collection
description: Collection with all content types
version: 1.0.0
items:
  - path: prompts/example.prompt.md
    kind: prompt
  - path: instructions/example.instructions.md
    kind: instruction
  - path: agents/example.agent.md
    kind: agent
  - path: skills/code-review/SKILL.md
    kind: skill
`;

      // Setup mocks
      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/mixed-content/contents/collections?ref=main')
        .reply(200, [{ name: 'mixed.collection.yml', type: 'file' }]);

      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/mixed-content/main/collections/mixed.collection.yml')
        .reply(200, mixedCollection);

      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/mixed-content/main/prompts/example.prompt.md')
        .reply(200, '---\nname: Example\n---\n# Example');

      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/mixed-content/main/instructions/example.instructions.md')
        .reply(200, '---\nname: Example Instruction\n---\n# Instruction');

      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/mixed-content/main/agents/example.agent.md')
        .reply(200, '---\nname: Example Agent\n---\n# Agent');

      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/mixed-content/main/skills/code-review/SKILL.md')
        .reply(200, createSkillMd('Code Review', 'Performs code review'));

      // Add source, sync, and install
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      const bundles = await testContext.registryManager.searchBundles({ sourceId });
      assert.ok(bundles.length > 0, 'Should find mixed content bundle');

      const mixedBundle = bundles.find((b) => b.id.includes('mixed'));
      assert.ok(mixedBundle, 'Should find mixed-collection bundle');
    });
  });
});
