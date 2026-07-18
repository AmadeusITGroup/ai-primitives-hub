import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TemplateContext,
  TemplateEngine,
} from '../../src/services/template-engine';

suite('TemplateEngine', () => {
  const templateRoot = path.join(process.cwd(), 'templates/scaffolds/github');
  let templateEngine: TemplateEngine;

  setup(() => {
    templateEngine = new TemplateEngine(templateRoot);
  });

  suite('renderTemplate', () => {
    test('should render template without variables', async () => {
      const context: TemplateContext = {
        projectName: 'Test',
        collectionId: 'test'
      };

      const content = await templateEngine.renderTemplate('example-prompt', context);
      assert.ok(content.includes('---') && content.includes('name:'), 'Should contain frontmatter');
    });

    test('should substitute variables in template', async () => {
      const context: TemplateContext = {
        projectName: 'My Project',
        collectionId: 'my-collection'
      };

      const content = await templateEngine.renderTemplate('example-collection', context);
      assert.ok(content.includes('my-collection'), 'Should substitute collectionId');
      assert.ok(content.includes('My Project'), 'Should substitute projectName');
    });

    test('should render package.json template', async () => {
      const context: TemplateContext = {
        projectName: 'Test Project',
        collectionId: 'test'
      };

      const content = await templateEngine.renderTemplate('package-json', context);
      const parsed = JSON.parse(content);
      assert.strictEqual(parsed.name, 'test-project', 'Should have kebab-case name');
      assert.ok(parsed.scripts, 'Should have scripts');
      assert.ok(parsed.scripts.validate, 'Should have validate script');
    });

    test('should throw error for unknown template', async () => {
      const context: TemplateContext = {
        projectName: 'Test',
        collectionId: 'test'
      };

      await assert.rejects(
        () => templateEngine.renderTemplate('nonexistent', context),
        /Template.*not found/
      );
    });
  });

  suite('scaffoldProject', () => {
    test('should create all required directories', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-test-'));
      const context: TemplateContext = {
        projectName: 'Awesome Project',
        collectionId: 'test-project'
      };

      await templateEngine.scaffoldProject(tempDir, context);

      assert.ok(fs.existsSync(path.join(tempDir, 'prompts')), 'Should create prompts directory');
      assert.ok(fs.existsSync(path.join(tempDir, 'instructions')), 'Should create instructions directory');
      assert.ok(fs.existsSync(path.join(tempDir, 'agents')), 'Should create agents directory');
      assert.ok(fs.existsSync(path.join(tempDir, 'collections')), 'Should create collections directory');
      assert.ok(fs.existsSync(path.join(tempDir, '.github', 'workflows')), 'Should create workflows directory');
      assert.ok(fs.existsSync(path.join(tempDir, 'scripts')), 'Should create scripts directory');

      // Cleanup
      fs.rmSync(tempDir, { recursive: true });
    });

    test('should create all template files', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-test-'));
      const context: TemplateContext = {
        projectName: 'Awesome Project',
        collectionId: 'test-project'
      };

      await templateEngine.scaffoldProject(tempDir, context);

      assert.ok(fs.existsSync(path.join(tempDir, 'prompts/example.prompt.md')), 'Should create example prompt');
      assert.ok(fs.existsSync(path.join(tempDir, 'instructions/example.instructions.md')), 'Should create example instruction');
      assert.ok(fs.existsSync(path.join(tempDir, 'agents/example.agent.md')), 'Should create example agent');
      assert.ok(fs.existsSync(path.join(tempDir, 'collections/example.collection.yml')), 'Should create example collection');
      assert.ok(fs.existsSync(path.join(tempDir, 'README.md')), 'Should create README');
      assert.ok(fs.existsSync(path.join(tempDir, 'package.json')), 'Should create package.json');
      assert.ok(fs.existsSync(path.join(tempDir, '.github/workflows/publish.yml')), 'Should create publish workflow');
      assert.ok(fs.existsSync(path.join(tempDir, 'scripts/README.md')), 'Should create scripts README');

      // Cleanup
      fs.rmSync(tempDir, { recursive: true });
    });

    test('should substitute variables in all files', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-test-'));
      const context: TemplateContext = {
        projectName: 'Awesome Project',
        collectionId: 'test-project'
      };

      await templateEngine.scaffoldProject(tempDir, context);

      // Check collection file
      const collectionContent = fs.readFileSync(
        path.join(tempDir, 'collections/example.collection.yml'),
        'utf8'
      );
      assert.ok(collectionContent.includes('test-project'), 'Collection should have project ID');
      assert.ok(collectionContent.includes('Awesome Project'), 'Collection should have project name');

      // Check package.json
      const packageContent = fs.readFileSync(
        path.join(tempDir, 'package.json'),
        'utf8'
      );
      const packageJson = JSON.parse(packageContent);
      assert.strictEqual(packageJson.name, 'awesome-project', 'Package should have substituted name');

      // Cleanup
      fs.rmSync(tempDir, { recursive: true });
    });

    test('should copy scripts README', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-test-'));
      const context: TemplateContext = {
        projectName: 'Test Project',
        collectionId: 'test'
      };

      await templateEngine.scaffoldProject(tempDir, context);

      const readmePath = path.join(tempDir, 'scripts/README.md');
      assert.ok(fs.existsSync(readmePath), 'Scripts README should be copied');

      const content = fs.readFileSync(readmePath, 'utf8');
      assert.ok(content.length > 0, 'README should have content');

      // Cleanup
      fs.rmSync(tempDir, { recursive: true });
    });

    test('should create base directory if not exists', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-test-'));
      const projectDir = path.join(tempDir, 'new-project');
      const context: TemplateContext = {
        projectName: 'Test',
        collectionId: 'test'
      };

      // Should not throw even though projectDir doesn't exist
      await templateEngine.scaffoldProject(projectDir, context);

      assert.ok(fs.existsSync(projectDir), 'Should create base directory');
      assert.ok(fs.existsSync(path.join(projectDir, 'prompts')), 'Should create subdirectories');

      // Cleanup
      fs.rmSync(tempDir, { recursive: true });
    });
  });
});
