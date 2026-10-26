/**
 * Tests for collection/create-plugin.ts: `createPlugin` scaffolds an
 * Agent Plugins 1.0.0 plugin at `<parentDir>/<name>/plugin.json`, rejects
 * an invalid name before writing anything, and never overwrites an
 * existing manifest.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
  validateAgentPluginItem,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createPlugin,
} from '../../src/collection/create-plugin';

let tempDir: string;
let parentDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-plugin-test-'));
  parentDir = path.join(tempDir, 'plugins');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('createPlugin()', () => {
  it('scaffolds a spec-compliant manifest at <parentDir>/<name>/plugin.json', async () => {
    const result = await createPlugin({ parentDir, name: 'my-plugin', author: 'Jane Doe' });
    const manifestPath = path.join(parentDir, 'my-plugin', 'plugin.json');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.pluginDir).toBe(path.join(parentDir, 'my-plugin'));
    expect(result.manifestPath).toBe(manifestPath);
    expect(result.createdFiles).toEqual([manifestPath]);

    const manifestText = fs.readFileSync(manifestPath, 'utf8');
    expect(JSON.parse(manifestText)).toEqual({
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
      name: 'my-plugin',
      version: '1.0.0',
      description: 'A my-plugin plugin',
      author: { name: 'Jane Doe' }
    });
    expect(validateAgentPluginItem({ itemPath: 'plugins/my-plugin/plugin.json', manifestText }))
      .toMatchObject({ valid: true, issues: [] });
  });

  it('uses the given description and version', async () => {
    const result = await createPlugin({
      parentDir, name: 'my-plugin', author: 'Jane', description: 'Say "hi"', version: '2.3.4'
    });
    const parsed = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')) as Record<string, unknown>;
    expect(parsed).toMatchObject({ description: 'Say "hi"', version: '2.3.4' });
  });

  it('rejects an invalid name with the spec rule and a suggestion, writing nothing', async () => {
    const result = await createPlugin({ parentDir, name: 'My_Plugin', author: 'Jane' });

    expect(result.success).toBe(false);
    expect(result.createdFiles).toEqual([]);
    expect(result.error?.code).toBe('invalid-name');
    expect(result.error?.message).toContain('got "My_Plugin"');
    expect(result.error?.hint).toContain('"my-plugin"');
    expect(fs.existsSync(parentDir)).toBe(false);
  });

  it('gives no suggestion when no valid name can be derived', async () => {
    const result = await createPlugin({ parentDir, name: '___', author: 'Jane' });

    expect(result.error?.code).toBe('invalid-name');
    expect(result.error?.hint).toBeUndefined();
    expect(fs.existsSync(parentDir)).toBe(false);
  });

  it('refuses to overwrite an existing plugin.json', async () => {
    const manifestPath = path.join(parentDir, 'my-plugin', 'plugin.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '{"keep":true}');

    const result = await createPlugin({ parentDir, name: 'my-plugin', author: 'Jane' });

    expect(result.success).toBe(false);
    expect(result.createdFiles).toEqual([]);
    expect(result.error?.code).toBe('already-exists');
    expect(result.error?.message).toContain(manifestPath);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe('{"keep":true}');
  });

  it('reports scaffold-failed when the parent path is a file', async () => {
    fs.writeFileSync(parentDir, 'not a directory');

    const result = await createPlugin({ parentDir, name: 'my-plugin', author: 'Jane' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('scaffold-failed');
  });

  // Creating a symlink needs extra privileges on Windows.
  it.skipIf(process.platform === 'win32')('does not write through a dangling plugin.json symlink', async () => {
    const manifestPath = path.join(parentDir, 'my-plugin', 'plugin.json');
    const outside = path.join(tempDir, 'outside.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.symlinkSync(outside, manifestPath);

    const result = await createPlugin({ parentDir, name: 'my-plugin', author: 'Jane' });

    expect(result.success).toBe(false);
    expect(result.createdFiles).toEqual([]);
    expect(result.error?.code).toBe('already-exists');
    expect(fs.existsSync(outside)).toBe(false);
  });
});
