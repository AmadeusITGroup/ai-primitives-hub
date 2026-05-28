/**
 * GitHub Scaffold Property-Based Tests
 *
 * Property-based tests using fast-check to verify GitHub scaffolding behavior
 * across many randomly generated scenarios.
 *
 * Feature: workflow-bundle-scaffolding
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fc from 'fast-check';
import {
  TemplateContext,
  TemplateEngine,
} from '../../src/services/template-engine';
import {
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

suite('GitHub Scaffold Property-Based Tests', () => {
  const templateRoot = path.join(process.cwd(), 'templates/scaffolds/github');
  let templateEngine: TemplateEngine;

  setup(() => {
    templateEngine = new TemplateEngine(templateRoot);
  });

  /**
   * Generator for valid project names
   * Format: lowercase alphanumeric with hyphens, 1-30 chars
   */
  const projectNameGenerator = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');
    return fc.array(fc.constantFrom(...chars), { minLength: 1, maxLength: 30 })
      .map((arr) => arr.join(''))
      .filter((s) => !s.startsWith('-') && !s.endsWith('-') && !s.includes('--'));
  };

  /**
   * Generator for valid collection IDs
   * Format: lowercase alphanumeric with hyphens, 1-100 chars (per Requirement 12.1)
   */
  const collectionIdGenerator = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');
    return fc.array(fc.constantFrom(...chars), { minLength: 1, maxLength: 50 })
      .map((arr) => arr.join(''))
      .filter((s) => !s.startsWith('-') && !s.endsWith('-') && !s.includes('--'));
  };

  /**
   * Generator for GitHub runner names
   */
  const githubRunnerGenerator = () => {
    return fc.constantFrom(
      'ubuntu-latest',
      'ubuntu-22.04',
      'ubuntu-20.04',
      'macos-latest',
      'macos-13',
      'windows-latest'
    );
  };

  /**
   * Generator for scaffold context
   */
  const scaffoldContextGenerator = () => {
    return fc.record({
      projectName: projectNameGenerator(),
      collectionId: collectionIdGenerator(),
      githubRunner: githubRunnerGenerator()
    });
  };

  /**
   * Property 1: Scaffolding Completeness
   * Feature: workflow-bundle-scaffolding, Property 1: Scaffolding Completeness
   * Validates: Requirements 1.2, 1.3, 2.1, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 9.1
   *
   * For any valid project name and scaffold options, when scaffolding a github project,
   * all files marked as required in the manifest should exist in the generated project structure.
   */
  test('Property 1: Scaffolding Completeness', async function () {
    this.timeout(PropertyTestConfig.TIMEOUT);

    // Required files that must exist after scaffolding
    // Note: Scripts are now provided via @prompt-registry/collection-scripts npm package
    const requiredFiles = [
      // GitHub workflows (Requirements 2.1)
      '.github/workflows/publish.yml',
      '.github/workflows/post-pr-comment.yml',
      '.github/actions/publish-common/action.yml',

      // Scripts directory documentation (npm package provides CLI commands)
      'scripts/README.md',

      // Example content files (Requirements 6.6)
      'prompts/example.prompt.md',
      'instructions/example.instructions.md',
      'agents/example.agent.md',
      'collections/example.collection.yml',

      // Configuration files (Requirements 6.2, 6.5, 8.1)
      'package.json',
      'README.md',
      '.gitignore',

      // VS Code settings (Requirements 6.5)
      '.vscode/settings.json',
      '.vscode/extensions.json',

      // Pre-commit hook (Requirements 6.4)
      '.githooks/pre-commit'
    ];

    // Required directories
    // Note: scripts/lib no longer needed - scripts provided via npm package
    const requiredDirectories = [
      'prompts',
      'instructions',
      'agents',
      'collections',
      'scripts',
      '.github',
      '.github/workflows',
      '.github/actions',
      '.github/actions/publish-common',
      '.vscode',
      '.githooks'
    ];

    await fc.assert(
      fc.asyncProperty(scaffoldContextGenerator(), async (config) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-prop-test-'));

        try {
          const context: TemplateContext = {
            projectName: config.projectName,
            collectionId: config.collectionId,
            githubRunner: config.githubRunner

          };

          // Scaffold the project
          await templateEngine.scaffoldProject(tempDir, context);

          // Verify all required directories exist
          for (const dir of requiredDirectories) {
            const dirPath = path.join(tempDir, dir);
            assert.ok(
              fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory(),
              `Required directory should exist: ${dir}`
            );
          }

          // Verify all required files exist
          for (const file of requiredFiles) {
            const filePath = path.join(tempDir, file);
            assert.ok(
              fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
              `Required file should exist: ${file}`
            );
          }

          // Verify files have content (not empty)
          for (const file of requiredFiles) {
            const filePath = path.join(tempDir, file);
            const content = fs.readFileSync(filePath, 'utf8');
            assert.ok(
              content.length > 0,
              `File should have content: ${file}`
            );
          }
        } finally {
          // Cleanup
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        }
      }),
      { numRuns: PropertyTestConfig.RUNS.STANDARD, ...PropertyTestConfig.FAST_CHECK_OPTIONS }
    );
  });

  /**
   * Property 2: Agent-Only Item Kinds
   * Feature: workflow-bundle-scaffolding, Property 2: Agent-Only Item Kinds
   * Validates: Requirements 3.1, 3.2, 3.3
   *
   * For any scaffolded github project, all generated collection files and example files
   * should use only valid item kinds ('prompt', 'instruction', 'agent', 'skill') and never include
   * 'chatmode' references.
   */
  test('Property 2: Agent-Only Item Kinds', async function () {
    this.timeout(PropertyTestConfig.TIMEOUT);

    // Valid item kinds per design document
    const validItemKinds = ['prompt', 'instruction', 'agent', 'skill'];

    // Files to check for item kind references
    const filesToCheck = [
      'collections/example.collection.yml',
      'agents/example.agent.md',
      'prompts/example.prompt.md',
      'instructions/example.instructions.md',
      'README.md'
    ];

    await fc.assert(
      fc.asyncProperty(scaffoldContextGenerator(), async (config) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-agent-test-'));

        try {
          const context: TemplateContext = {
            projectName: config.projectName,
            collectionId: config.collectionId,
            githubRunner: config.githubRunner

          };

          // Scaffold the project
          await templateEngine.scaffoldProject(tempDir, context);

          // Check each file for chatmode references
          // Note: README.md may mention chatmode in migration context, which is OK
          for (const file of filesToCheck) {
            const filePath = path.join(tempDir, file);
            if (fs.existsSync(filePath)) {
              const content = fs.readFileSync(filePath, 'utf8');

              // For README.md, we allow chatmode mentions in migration context
              // but verify it's not used as the primary/recommended kind
              if (file === 'README.md') {
                // README should not have chatmode as a recommended kind in examples
                // outside of migration/before sections
                // Check that any 'kind: chatmode' appears only in "Before" examples
                const lines = content.split('\n');
                let inBeforeSection = false;
                for (let i = 0; i < lines.length; i++) {
                  const line = lines[i];
                  // Track if we're in a "Before" example section
                  if (/^#\s*before/i.test(line) || line.includes('# Before')) {
                    inBeforeSection = true;
                  } else if (/^#\s*after/i.test(line) || line.includes('# After') || line.startsWith('##')) {
                    inBeforeSection = false;
                  }

                  // If we find 'kind: chatmode' outside a Before section, fail
                  if (/kind:\s*chatmode/i.test(line) && !inBeforeSection) {
                    // Check if this line is in a code block showing migration
                    const contextStart = Math.max(0, i - 5);
                    const contextLines = lines.slice(contextStart, i + 1).join('\n');
                    const isMigrationExample = /before|migration|deprecated/i.test(contextLines);
                    assert.ok(
                      isMigrationExample,
                      `README.md should only show 'kind: chatmode' in migration/before examples, found at line ${i + 1}`
                    );
                  }
                }
                continue; // Skip the generic checks for README
              }

              // For non-README files, no chatmode references should exist
              const chatmodeKindPattern = /kind:\s*chatmode/i;
              assert.ok(
                !chatmodeKindPattern.test(content),
                `File ${file} should not contain 'kind: chatmode'`
              );

              // Check for .chatmode.md file references (except in migration docs)
              if (file !== 'README.md') {
                const chatmodeFilePattern = /\.chatmode\.md/i;
                assert.ok(
                  !chatmodeFilePattern.test(content),
                  `File ${file} should not reference .chatmode.md files`
                );
              }
            }
          }

          // Specifically verify the collection file uses only valid kinds
          const collectionPath = path.join(tempDir, 'collections/example.collection.yml');
          const collectionContent = fs.readFileSync(collectionPath, 'utf8');

          // Extract all kind values from the collection
          const kindMatches = collectionContent.match(/kind:\s*(\w+)/g) || [];
          for (const match of kindMatches) {
            const kindValue = match.replace(/kind:\s*/, '').toLowerCase();
            assert.ok(
              validItemKinds.includes(kindValue),
              `Collection should only use valid item kinds (${validItemKinds.join(', ')}), found: ${kindValue}`
            );
          }

          // Verify agent example file exists (not chatmode)
          const agentPath = path.join(tempDir, 'agents/example.agent.md');
          assert.ok(
            fs.existsSync(agentPath),
            'Agent example file should exist at agents/example.agent.md'
          );

          // Verify no chatmode directory or files exist
          const chatmodePath = path.join(tempDir, 'chatmodes');
          assert.ok(
            !fs.existsSync(chatmodePath),
            'Chatmodes directory should not exist'
          );
        } finally {
          // Cleanup
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        }
      }),
      { numRuns: PropertyTestConfig.RUNS.STANDARD, ...PropertyTestConfig.FAST_CHECK_OPTIONS }
    );
  });

  /**
   * Property 4: GitHub Runner Substitution
   * Feature: workflow-bundle-scaffolding, Property 4: GitHub Runner Substitution
   * Validates: Requirements 2.6
   *
   * For any githubRunner value provided in scaffold options, all generated workflow files
   * should contain that exact runner value in their `runs-on` fields.
   */
  test('Property 4: GitHub Runner Substitution', async function () {
    this.timeout(PropertyTestConfig.TIMEOUT);

    await fc.assert(
      fc.asyncProperty(scaffoldContextGenerator(), async (config) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-runner-test-'));

        try {
          const context: TemplateContext = {
            projectName: config.projectName,
            collectionId: config.collectionId,
            githubRunner: config.githubRunner

          };

          // Scaffold the project
          await templateEngine.scaffoldProject(tempDir, context);

          // Check all workflow files for the runner value
          const workflowFiles = [
            '.github/workflows/publish.yml',
            '.github/workflows/post-pr-comment.yml'
          ];

          for (const workflowFile of workflowFiles) {
            const workflowPath = path.join(tempDir, workflowFile);
            const workflowContent = fs.readFileSync(workflowPath, 'utf8');

            // Verify the runner value is present
            assert.ok(
              workflowContent.includes(`runs-on: ${config.githubRunner}`),
              `Workflow ${workflowFile} should contain runs-on: ${config.githubRunner}`
            );

            // Verify no unsubstituted template variables remain
            assert.ok(
              !workflowContent.includes('{{githubRunner}}'),
              `Workflow ${workflowFile} should not contain unsubstituted {{githubRunner}}`
            );
          }
        } finally {
          // Cleanup
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        }
      }),
      { numRuns: PropertyTestConfig.RUNS.STANDARD, ...PropertyTestConfig.FAST_CHECK_OPTIONS }
    );
  });

  /**
   * Property 12a: CI Workflow Automatic Validation
   * Feature: workflow-bundle-scaffolding, Property 12a: CI Workflow Automatic Validation
   * Validates: Requirements 9.4
   *
   * For any scaffolded github project, the publish.yml workflow should include validation
   * steps that execute automatically on push and pull request events before any publishing
   * occurs.
   */
  test('Property 12a: CI Workflow Automatic Validation', async function () {
    this.timeout(PropertyTestConfig.TIMEOUT);

    await fc.assert(
      fc.asyncProperty(scaffoldContextGenerator(), async (config) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-ci-validation-test-'));

        try {
          const context: TemplateContext = {
            projectName: config.projectName,
            collectionId: config.collectionId,
            githubRunner: config.githubRunner

          };

          // Scaffold the project
          await templateEngine.scaffoldProject(tempDir, context);

          // Read publish.yml workflow
          const publishWorkflowPath = path.join(tempDir, '.github/workflows/publish.yml');
          const publishWorkflowContent = fs.readFileSync(publishWorkflowPath, 'utf8');

          // Read publish-common action
          const publishCommonPath = path.join(tempDir, '.github/actions/publish-common/action.yml');
          const publishCommonContent = fs.readFileSync(publishCommonPath, 'utf8');

          // Verify publish.yml has push and pull_request triggers
          assert.ok(
            publishWorkflowContent.includes('push:'),
            'publish.yml should have push trigger for automatic validation'
          );
          assert.ok(
            publishWorkflowContent.includes('pull_request:'),
            'publish.yml should have pull_request trigger for automatic validation'
          );
          assert.ok(
            publishWorkflowContent.includes('workflow_dispatch:'),
            'publish.yml should have workflow_dispatch trigger for manual runs'
          );

          // Verify publish.yml uses the publish-common action
          assert.ok(
            publishWorkflowContent.includes('uses: ./.github/actions/publish-common'),
            'publish.yml should use the publish-common action'
          );

          // Verify publish-common action includes validation step
          assert.ok(
            publishCommonContent.includes('Validate collections')
            || publishCommonContent.includes('npm run validate'),
            'publish-common action should include validation step'
          );

          // Verify validation runs before publishing
          // The publish-common action should run before the publish step
          const publishCommonIndex = publishWorkflowContent.indexOf('publish-common');
          const publishCollectionsIndex = publishWorkflowContent.indexOf('Publish affected collections');

          assert.ok(
            publishCommonIndex < publishCollectionsIndex,
            'publish-common (with validation) should run before publishing collections'
          );

          // Verify both jobs (publish-collections and publish-preview) use validation
          assert.ok(
            (publishWorkflowContent.match(/uses: \.\/\.github\/actions\/publish-common/g) || []).length >= 2,
            'Both publish-collections and publish-preview jobs should use publish-common action'
          );

          // Verify the publish-common action has the validation step in the correct order
          // (after dependencies are installed, before any publishing)
          const installDepsIndex = publishCommonContent.indexOf('Install dependencies');
          const validateIndex = publishCommonContent.indexOf('Validate collections');

          assert.ok(
            installDepsIndex < validateIndex,
            'Validation should run after dependencies are installed'
          );
        } finally {
          // Cleanup
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        }
      }),
      { numRuns: PropertyTestConfig.RUNS.STANDARD, ...PropertyTestConfig.FAST_CHECK_OPTIONS }
    );
  });
});
