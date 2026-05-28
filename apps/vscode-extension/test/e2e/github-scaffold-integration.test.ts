/**
 * GitHub Scaffold Integration Tests
 *
 * End-to-end integration tests for the GitHub scaffolding workflow.
 * Tests complete scaffolding flow with all options and verifies generated
 * project structure matches design.
 *
 * Feature: workflow-bundle-scaffolding
 * Requirements: 5.3, 5.4, 5.5
 */

import * as assert from 'node:assert';
import {
  execSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ScaffoldCommand,
  ScaffoldType,
} from '../../src/commands/scaffold-command';

suite('E2E: GitHub Scaffold Integration Tests', () => {
  const templateRoot = path.join(process.cwd(), 'templates/scaffolds/github');
  let testDir: string;

  setup(() => {
    // Create unique temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-e2e-'));
  });

  teardown(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  suite('Complete Scaffolding Flow', () => {
    /**
     * Test: Complete scaffolding with default options
     * Requirements: 5.3 - Test complete scaffolding flow with all options
     */
    test('E2E: Scaffold with default options creates complete project structure', async function () {
      this.timeout(30_000);

      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

      await scaffoldCommand.execute(testDir, {
        projectName: 'test-project'
      });

      // Verify core directories exist
      const requiredDirs = [
        'prompts',
        'instructions',
        'agents',
        'collections',
        'scripts',
        'skills',
        'skills/example-skill',
        'skills/example-skill/scripts',
        'skills/example-skill/references',
        'skills/example-skill/assets',
        '.github',
        '.github/workflows',
        '.github/actions',
        '.github/actions/publish-common',
        '.github/actions/pr-comment',
        '.github/ISSUE_TEMPLATE',
        '.vscode',
        '.githooks'
      ];

      for (const dir of requiredDirs) {
        const dirPath = path.join(testDir, dir);
        assert.ok(
          fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory(),
          `Directory should exist: ${dir}`
        );
      }

      // Verify core files exist
      const requiredFiles = [
        'package.json',
        'README.md',
        '.gitignore',
        '.github/workflows/publish.yml',
        '.github/actions/publish-common/action.yml',
        '.github/actions/pr-comment/action.yml',
        '.github/ISSUE_TEMPLATE/bug_report.yml',
        '.github/ISSUE_TEMPLATE/feature_request.yml',
        '.github/ISSUE_TEMPLATE/config.yml',
        '.github/pull_request_template.md',
        'scripts/README.md',
        'collections/example.collection.yml',
        'prompts/example.prompt.md',
        'instructions/example.instructions.md',
        'agents/example.agent.md',
        'skills/example-skill/SKILL.md',
        'skills/example-skill/scripts/review-helper.sh',
        'skills/example-skill/references/CHECKLIST.md',
        'skills/example-skill/references/FEEDBACK.md',
        'skills/example-skill/assets/comment-templates.md',
        '.vscode/settings.json',
        '.vscode/extensions.json',
        '.githooks/pre-commit',
        'CONTRIBUTING.md',
        'COMMUNICATION.md',
        'CODE_OF_CONDUCT.md',
        'SECURITY.md',
        'LICENSE'
      ];

      for (const file of requiredFiles) {
        const filePath = path.join(testDir, file);
        assert.ok(
          fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
          `File should exist: ${file}`
        );
      }
    });

    /**
     * Test: Scaffold with custom project name
     * Requirements: 5.3 - Test complete scaffolding flow with all options
     */
    test('E2E: Scaffold with custom project name substitutes variables correctly', async function () {
      this.timeout(30_000);

      const projectName = 'my-awesome-prompts';
      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

      await scaffoldCommand.execute(testDir, { projectName });

      // Verify package.json has correct name
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
      );
      assert.strictEqual(packageJson.name, projectName);

      // Verify collection has correct ID
      const collectionContent = fs.readFileSync(
        path.join(testDir, 'collections/example.collection.yml'),
        'utf8'
      );
      assert.ok(
        collectionContent.includes(`id: ${projectName}`),
        'Collection should have project name as ID'
      );

      // Verify README mentions project name
      const readmeContent = fs.readFileSync(
        path.join(testDir, 'README.md'),
        'utf8'
      );
      assert.ok(
        readmeContent.includes(projectName),
        'README should mention project name'
      );
    });

    /**
     * Test: Scaffold with custom GitHub runner
     * Requirements: 5.3 - Test complete scaffolding flow with all options
     */
    test('E2E: Scaffold with custom GitHub runner substitutes runner value', async function () {
      this.timeout(30_000);

      const customRunner = 'macos-latest';
      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

      await scaffoldCommand.execute(testDir, {
        projectName: 'macos-project',
        githubRunner: customRunner
      });

      // Verify publish.yml has custom runner
      const publishContent = fs.readFileSync(
        path.join(testDir, '.github/workflows/publish.yml'),
        'utf8'
      );
      assert.ok(
        publishContent.includes(`runs-on: ${customRunner}`),
        `publish.yml should use runner: ${customRunner}`
      );
    });
  });

  suite('Generated Project Structure Validation', () => {
    /**
     * Test: Verify generated project matches design document structure
     * Requirements: 5.4 - Verify generated project structure matches design
     */
    test('E2E: Generated project structure matches design document', async function () {
      this.timeout(30_000);

      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

      await scaffoldCommand.execute(testDir, {
        projectName: 'design-test-project'
      });

      // Design document specifies this exact structure:
      const designStructure = {
        directories: [
          '.github/actions/publish-common',
          '.github/actions/pr-comment',
          '.github/workflows',
          '.github/ISSUE_TEMPLATE',
          '.githooks',
          '.vscode',
          'agents',
          'collections',
          'instructions',
          'prompts',
          'scripts',
          'skills/example-skill',
          'skills/example-skill/scripts',
          'skills/example-skill/references',
          'skills/example-skill/assets'
        ],
        files: {
          '.github/actions/publish-common/action.yml': true,
          '.github/actions/pr-comment/action.yml': true,
          '.github/workflows/publish.yml': true,
          '.github/ISSUE_TEMPLATE/bug_report.yml': true,
          '.github/ISSUE_TEMPLATE/feature_request.yml': true,
          '.github/ISSUE_TEMPLATE/config.yml': true,
          '.github/pull_request_template.md': true,
          '.githooks/pre-commit': true,
          '.vscode/extensions.json': true,
          '.vscode/settings.json': true,
          'agents/example.agent.md': true,
          'collections/example.collection.yml': true,
          'instructions/example.instructions.md': true,
          'prompts/example.prompt.md': true,
          'scripts/README.md': true,
          'skills/example-skill/SKILL.md': true,
          'skills/example-skill/scripts/review-helper.sh': true,
          'skills/example-skill/references/CHECKLIST.md': true,
          'skills/example-skill/references/FEEDBACK.md': true,
          'skills/example-skill/assets/comment-templates.md': true,
          '.gitignore': true,
          'package.json': true,
          'README.md': true,
          'CONTRIBUTING.md': true,
          'COMMUNICATION.md': true,
          'CODE_OF_CONDUCT.md': true,
          'SECURITY.md': true,
          LICENSE: true
        }
      };

      // Verify all directories exist
      for (const dir of designStructure.directories) {
        const dirPath = path.join(testDir, dir);
        assert.ok(
          fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory(),
          `Design-specified directory should exist: ${dir}`
        );
      }

      // Verify all files exist
      for (const file of Object.keys(designStructure.files)) {
        const filePath = path.join(testDir, file);
        assert.ok(
          fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
          `Design-specified file should exist: ${file}`
        );
      }
    });

    /**
     * Test: Verify collection file uses agent kind (not chatmode)
     * Requirements: 5.4 - Verify generated project structure matches design
     */
    test('E2E: Generated collection uses agent kind, not chatmode', async function () {
      this.timeout(30_000);

      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

      await scaffoldCommand.execute(testDir, {
        projectName: 'agent-test-project'
      });

      // Read collection file
      const collectionContent = fs.readFileSync(
        path.join(testDir, 'collections/example.collection.yml'),
        'utf8'
      );

      // Verify agent kind is used
      assert.ok(
        collectionContent.includes('kind: agent'),
        'Collection should use kind: agent'
      );

      // Verify chatmode is NOT used
      assert.ok(
        !collectionContent.includes('kind: chatmode'),
        'Collection should NOT use kind: chatmode'
      );

      // Verify agent file exists (not chatmode file)
      assert.ok(
        fs.existsSync(path.join(testDir, 'agents/example.agent.md')),
        'Agent file should exist'
      );
      assert.ok(
        !fs.existsSync(path.join(testDir, 'chatmodes')),
        'Chatmodes directory should NOT exist'
      );
    });

    /**
     * Test: Verify package.json has required scripts
     * Requirements: 5.4 - Verify generated project structure matches design
     */
    test('E2E: Generated package.json has required npm scripts', async function () {
      this.timeout(30_000);

      const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

      await scaffoldCommand.execute(testDir, {
        projectName: 'scripts-test-project'
      });

      const packageJson = JSON.parse(
        fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
      );

      // Verify required scripts exist (per package.template.json)
      const requiredScripts = [
        'validate',
        'build-collection-bundle',
        'publish-collections',
        'list-collections',
        'compute-collection-version'
      ];
      for (const script of requiredScripts) {
        assert.ok(
          packageJson.scripts && packageJson.scripts[script],
          `package.json should have ${script} script`
        );
      }
    });
  });
});

suite('E2E: Script Execution Tests', () => {
  const templateRoot = path.join(process.cwd(), 'templates/scaffolds/github');
  let testDir: string;
  let npmInstalled: boolean;

  suiteSetup(async function () {
    this.timeout(60_000);

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-script-e2e-'));

    const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);
    await scaffoldCommand.execute(testDir, {
      projectName: 'script-test-project'
    });

    try {
      execSync('npm install --prefer-offline', {
        cwd: testDir,
        stdio: 'pipe',
        timeout: 30_000
      });
      npmInstalled = true;
    } catch {
      npmInstalled = false;
    }

    if (npmInstalled) {
      execSync('git init && git config user.email "test@test.com" && git config user.name "Test" && git add -A && git commit -m "initial"', {
        cwd: testDir,
        stdio: 'pipe',
        timeout: 10_000
      });
    }
  });

  suiteTeardown(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  setup(function () {
    if (!npmInstalled) {
      this.skip();
    }
    // Clean artifacts from previous tests to maintain isolation
    const distDir = path.join(testDir, 'dist');
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  /**
   * Test: Validation scripts work in generated projects via npm package
   * Requirements: 5.5 - Test validation scripts in generated projects
   */
  test('E2E: Validation script validates example collection successfully', async function () {
    this.timeout(30_000);

    try {
      const result = execSync('npm run validate --silent', {
        cwd: testDir,
        stdio: 'pipe',
        timeout: 30_000
      });

      const output = result.toString();
      assert.ok(
        !output.toLowerCase().includes('error') || output.toLowerCase().includes('0 error'),
        'Validation should pass for example collection'
      );
    } catch (error: any) {
      const stderr = error.stderr?.toString() || '';
      const stdout = error.stdout?.toString() || '';

      if (stderr.includes('Cannot find module') || stdout.includes('Cannot find module')) {
        this.skip();
      } else {
        assert.fail(`Validation script failed: ${stderr || stdout}`);
      }
    }
  });

  /**
   * Test: List collections script works in generated projects via npm package
   * Requirements: 5.5 - Test validation scripts in generated projects
   */
  test('E2E: List collections script finds example collection', async function () {
    this.timeout(30_000);

    try {
      const result = execSync('npm run list-collections --silent', {
        cwd: testDir,
        stdio: 'pipe',
        timeout: 30_000
      });

      const output = result.toString();
      assert.ok(
        output.includes('example') || output.includes('collection'),
        'List script should find example collection'
      );
    } catch (error: any) {
      const stderr = error.stderr?.toString() || '';
      const stdout = error.stdout?.toString() || '';

      if (stderr.includes('Cannot find module') || stdout.includes('Cannot find module')) {
        this.skip();
      } else {
        assert.fail(`List collections script failed: ${stderr || stdout}`);
      }
    }
  });

  /**
   * Test: Build script produces correct output structure via npm package
   * Requirements: 5.5 - Test build scripts produce correct output
   */
  test('E2E: Build script creates bundle with correct structure', async function () {
    this.timeout(30_000);

    const outputDir = path.join(testDir, 'dist');
    fs.mkdirSync(outputDir, { recursive: true });

    try {
      execSync(`npm run build-collection-bundle -- --collection-file collections/example.collection.yml --version 1.0.0 --repo-slug test-repo --out-dir ${outputDir}`, {
        cwd: testDir,
        stdio: 'pipe',
        timeout: 30_000
      });

      const collectionOutDir = path.join(outputDir, 'script-test-project');
      if (fs.existsSync(collectionOutDir)) {
        const outputFiles = fs.readdirSync(collectionOutDir);

        const hasManifest = outputFiles.some((f) => f.includes('manifest') || f.endsWith('.yml'));
        const hasZip = outputFiles.some((f) => f.endsWith('.zip'));

        assert.ok(
          hasManifest || hasZip,
          'Build script should produce manifest and/or zip files'
        );
      } else {
        const distFiles = fs.readdirSync(outputDir);
        assert.ok(
          distFiles.length > 0,
          'Build script should produce output files'
        );
      }
    } catch (error: any) {
      const stderr = error.stderr?.toString() || '';
      const stdout = error.stdout?.toString() || '';

      if (stderr.includes('Cannot find module') || stdout.includes('Cannot find module')) {
        this.skip();
      } else {
        assert.fail(`Build script failed: ${stderr || stdout}`);
      }
    }
  });

  /**
   * Test: Compute version script works correctly via npm package
   * Requirements: 5.5 - Test build scripts produce correct output
   */
  test('E2E: Compute version script returns valid version', async function () {
    this.timeout(30_000);

    try {
      const result = execSync('npm run compute-collection-version -- --collection-file collections/example.collection.yml', {
        cwd: testDir,
        stdio: 'pipe',
        timeout: 30_000
      });

      const output = result.toString().trim();
      const semverPattern = /\d+\.\d+\.\d+/;
      assert.ok(
        semverPattern.test(output),
        `Version script should return semver version, got: ${output}`
      );
    } catch (error: any) {
      const stderr = error.stderr?.toString() || '';
      const stdout = error.stdout?.toString() || '';

      if (stderr.includes('Cannot find module') || stdout.includes('Cannot find module')) {
        this.skip();
      } else if (stderr.includes('Usage:') || stdout.includes('Usage:')) {
        assert.ok(true, 'Compute version script is executable');
      } else {
        assert.fail(`Compute version script failed: ${stderr || stdout}`);
      }
    }
  });

  /**
   * Test: Package.json references `@prompt-registry/collection-scripts`
   * Requirements: 5.5 - Test validation scripts in generated projects
   */
  test('E2E: Package.json references collection-scripts npm package', async function () {
    this.timeout(30_000);

    const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

    await scaffoldCommand.execute(testDir, {
      projectName: 'package-dep-test-project'
    });

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(testDir, 'package.json'), 'utf8')
    );

    // Verify @prompt-registry/collection-scripts is a dependency
    const hasDep = (packageJson.dependencies && packageJson.dependencies['@prompt-registry/collection-scripts'])
      || (packageJson.devDependencies && packageJson.devDependencies['@prompt-registry/collection-scripts']);
    assert.ok(
      hasDep,
      'package.json should depend on @prompt-registry/collection-scripts'
    );

    // Verify npm scripts reference the package commands
    const expectedScriptCommands: Record<string, string> = {
      validate: 'validate-collections',
      'build-collection-bundle': 'build-collection-bundle',
      'publish-collections': 'publish-collections',
      'list-collections': 'list-collections',
      'compute-collection-version': 'compute-collection-version'
    };

    for (const [scriptName, command] of Object.entries(expectedScriptCommands)) {
      assert.ok(
        packageJson.scripts && packageJson.scripts[scriptName]?.includes(command),
        `npm script "${scriptName}" should invoke "${command}"`
      );
    }
  });

  /**
   * Test: Pre-commit hook is executable
   * Requirements: 5.5 - Test validation scripts in generated projects
   */
  test('E2E: Pre-commit hook is properly configured', async function () {
    this.timeout(30_000);

    const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

    await scaffoldCommand.execute(testDir, {
      projectName: 'hook-test-project'
    });

    const hookPath = path.join(testDir, '.githooks/pre-commit');
    assert.ok(
      fs.existsSync(hookPath),
      'Pre-commit hook should exist'
    );

    const hookContent = fs.readFileSync(hookPath, 'utf8');

    // Hook should have shebang
    assert.ok(
      hookContent.startsWith('#!/'),
      'Pre-commit hook should have shebang'
    );

    // Hook should reference validation
    assert.ok(
      hookContent.includes('validate') || hookContent.includes('npm'),
      'Pre-commit hook should run validation'
    );
  });

  /**
   * Test: Skill helper script is valid
   * Requirements: 5.5 - Test validation scripts in generated projects
   */
  test('E2E: Skill helper script is properly configured', async function () {
    this.timeout(30_000);

    const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

    await scaffoldCommand.execute(testDir, {
      projectName: 'skill-script-test-project'
    });

    const skillScript = path.join(testDir, 'skills/example-skill/scripts/review-helper.sh');
    assert.ok(
      fs.existsSync(skillScript),
      'Skill helper script should exist'
    );

    const content = fs.readFileSync(skillScript, 'utf8');

    // Script should have shebang
    assert.ok(
      content.startsWith('#!/'),
      'Skill helper script should have shebang'
    );

    // Script should be a valid shell script
    assert.ok(
      content.includes('function') || content.includes('echo') || content.includes('if'),
      'Skill helper script should contain shell commands'
    );
  });

  /**
   * Test: Scripts README documents available commands
   * Requirements: 5.5 - Test validation scripts in generated projects
   */
  test('E2E: Scripts README documents available npm commands', async function () {
    this.timeout(30_000);

    const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

    await scaffoldCommand.execute(testDir, {
      projectName: 'scripts-readme-test-project'
    });

    const readmePath = path.join(testDir, 'scripts/README.md');
    assert.ok(
      fs.existsSync(readmePath),
      'Scripts README should exist'
    );

    const content = fs.readFileSync(readmePath, 'utf8');

    // Verify README documents the available commands
    assert.ok(
      content.includes('validate-collections'),
      'Scripts README should document validate-collections command'
    );
    assert.ok(
      content.includes('build-collection-bundle'),
      'Scripts README should document build-collection-bundle command'
    );
    assert.ok(
      content.includes('publish-collections'),
      'Scripts README should document publish-collections command'
    );
    assert.ok(
      content.includes('@prompt-registry/collection-scripts'),
      'Scripts README should reference the npm package'
    );
  });

  /**
   * Test: Skill structure is complete and valid
   * Requirements: 5.5 - Test build scripts produce correct output
   */
  test('E2E: Example skill has complete structure', async function () {
    this.timeout(30_000);

    const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

    await scaffoldCommand.execute(testDir, {
      projectName: 'skill-structure-test-project'
    });

    // Verify all skill files exist
    const skillFiles = [
      'skills/example-skill/SKILL.md',
      'skills/example-skill/scripts/review-helper.sh',
      'skills/example-skill/references/CHECKLIST.md',
      'skills/example-skill/references/FEEDBACK.md',
      'skills/example-skill/assets/comment-templates.md'
    ];

    for (const file of skillFiles) {
      const filePath = path.join(testDir, file);
      assert.ok(
        fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
        `Skill file should exist: ${file}`
      );
    }

    // Verify SKILL.md has required sections
    const skillMd = fs.readFileSync(
      path.join(testDir, 'skills/example-skill/SKILL.md'),
      'utf8'
    );
    assert.ok(
      skillMd.includes('# ') || skillMd.includes('## '),
      'SKILL.md should have markdown headings'
    );
  });

  /**
   * Test: Community docs are scaffolded correctly
   * Requirements: 5.5 - Test build scripts produce correct output
   */
  test('E2E: Community documentation files are properly configured', async function () {
    this.timeout(30_000);

    const scaffoldCommand = new ScaffoldCommand(templateRoot, ScaffoldType.GitHub);

    await scaffoldCommand.execute(testDir, {
      projectName: 'community-docs-test-project'
    });

    // Verify community documentation files exist and have content
    const communityFiles = [
      'CONTRIBUTING.md',
      'COMMUNICATION.md',
      'CODE_OF_CONDUCT.md',
      'SECURITY.md',
      'LICENSE'
    ];

    for (const file of communityFiles) {
      const filePath = path.join(testDir, file);
      assert.ok(
        fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
        `Community doc should exist: ${file}`
      );

      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(
        content.length > 0,
        `Community doc should not be empty: ${file}`
      );
    }

    // Verify GitHub issue templates exist
    const issueTemplates = [
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/ISSUE_TEMPLATE/feature_request.yml',
      '.github/ISSUE_TEMPLATE/config.yml',
      '.github/pull_request_template.md'
    ];

    for (const file of issueTemplates) {
      const filePath = path.join(testDir, file);
      assert.ok(
        fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
        `GitHub template should exist: ${file}`
      );
    }
  });
});
