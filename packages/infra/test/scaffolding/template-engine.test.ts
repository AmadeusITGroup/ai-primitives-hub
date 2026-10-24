/**
 * Tests for scaffolding/template-engine.ts: the plugin template renders an
 * Agent Plugins 1.0.0 manifest, and values substituted into JSON templates
 * are JSON-string-escaped (markdown templates stay verbatim).
 *
 * Uses the real template directories and a real temp dir.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
  validateAgentPluginManifest,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  TEMPLATE_PATHS,
  TemplateEngine,
} from '../../src/scaffolding';
import {
  createTempDir,
} from '../helpers/temp-dir';

const QUOTED = 'Say "hi" \\ bye';

const pluginContext = (description: string) => ({
  projectName: 'my-plugin',
  collectionId: 'my-plugin',
  name: 'my-plugin',
  version: '1.0.0',
  author: 'Jane Doe',
  description,
  schemaUri: AGENT_PLUGIN_MANIFEST_SCHEMA_URI
});

describe('TemplateEngine', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    [dir, cleanup] = createTempDir('template-engine-');
  });

  afterEach(() => {
    cleanup();
  });

  describe('plugin template', () => {
    it('renders a spec-compliant Agent Plugins 1.0.0 manifest', async () => {
      const text = await new TemplateEngine(TEMPLATE_PATHS.plugin).renderTemplate('plugin-md', pluginContext(QUOTED));
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed.$schema).toBe(AGENT_PLUGIN_MANIFEST_SCHEMA_URI);
      expect(parsed.name).toBe('my-plugin');
      expect(parsed.author).toEqual({ name: 'Jane Doe' });
      expect(parsed.description).toBe(QUOTED);
      expect(validateAgentPluginManifest(parsed).filter((i) => i.severity === 'fatal')).toEqual([]);
    });

    it('writes only plugin.json into the target directory', async () => {
      const target = join(dir, 'plugins', 'my-plugin');
      const result = await new TemplateEngine(TEMPLATE_PATHS.plugin).scaffoldProject(target, pluginContext('d'));
      expect(result).toEqual({ success: true, createdFiles: [join(target, 'plugin.json')] });
      expect(readdirSync(join(dir, 'plugins'))).toEqual(['my-plugin']);
      expect(readdirSync(target)).toEqual(['plugin.json']);
    });
  });

  describe('value escaping', () => {
    it('leaves values verbatim in markdown templates', async () => {
      const result = await new TemplateEngine(TEMPLATE_PATHS.skill)
        .scaffoldProject(dir, { projectName: 'my-skill', collectionId: 'my-skill', name: 'my-skill', description: 'Say "hi"' });
      expect(result.success).toBe(true);
      const skillMd = join(dir, 'my-skill', 'SKILL.md');
      expect(existsSync(skillMd)).toBe(true);
      expect(readFileSync(skillMd, 'utf8')).toContain('Say "hi"');
    });

    it('produces parseable JSON from the hook template', async () => {
      const text = await new TemplateEngine(TEMPLATE_PATHS.hook)
        .renderTemplate('hook-json', { projectName: 'my-hook', collectionId: 'my-hook', name: 'my-hook', type: 'pre-commit', description: QUOTED });
      expect((JSON.parse(text) as { description: string }).description).toBe(QUOTED);
    });

    it('does not expand placeholders that appear inside substituted values', async () => {
      const text = await new TemplateEngine(TEMPLATE_PATHS.plugin)
        .renderTemplate('plugin-md', { ...pluginContext('{{schemaUri}}'), author: '{{name}}' });
      const parsed = JSON.parse(text) as { description: string; author: { name: string } };
      expect(parsed.description).toBe('{{schemaUri}}');
      expect(parsed.author.name).toBe('{{name}}');
    });
  });
});
