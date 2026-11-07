/**
 * Agent Plugin bundle fixtures.
 *
 * A bundle `demo-plugin` whose plugin item follows Agent Plugins 1.0.0:
 * `plugins/demo-plugin/plugin.json`, a skill, a root `mcp.json` with one
 * stdio server using `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`, and an
 * executable `scripts/run.sh`. `mixed` adds the prompt `hello` after the
 * plugin; `prompt` holds the prompt only.
 *
 * {@link writePluginBundleZip} builds the archive in-process;
 * {@link buildPluginBundleWithCli} builds it with the real CLI
 * (`plugin create`, `collection validate`, `bundle build`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import * as yaml from 'js-yaml';
import {
  runBuiltCliOk,
} from './cli-runner';
import {
  runGit,
} from './git-test-helpers';

/** Content of a fixture bundle. */
export type PluginBundleKind = 'plugin' | 'mixed' | 'prompt';

/** Options of {@link writePluginBundleZip}. */
export interface PluginBundleZipOptions {
  /** Bundle and plugin version (default `1.0.0`). */
  version?: string;
  /** Add a manifest `mcpServers` block. */
  withMcpServers?: boolean;
}

/** A written fixture archive. */
export interface PluginBundleZip {
  /** Path of the written archive. */
  zipPath: string;
  /** Archive bytes. */
  bytes: Buffer;
}

/** A CLI-built fixture bundle. */
export interface CliBuiltPluginBundle {
  /** Archive written by `bundle build`. */
  zipPath: string;
  /** The archive extracted with file modes kept. */
  unpackedDir: string;
}

/** Bundle, plugin and collection id of every fixture. */
export const DEMO_PLUGIN_ID = 'demo-plugin';
const PLUGIN_DIR = `plugins/${DEMO_PLUGIN_ID}`;
// adm-zip's addFile takes the permission bits and adds the regular-file type itself.
const EXECUTABLE_ATTR = 0o755;
const REGULAR_ATTR = 0o644;

/**
 * Plugin files below the plugin directory, the run script excluded.
 * @param version
 */
const pluginFiles = (version: string): Record<string, string> => ({
  'plugin.json': `${JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: DEMO_PLUGIN_ID,
    version,
    description: 'Demo plugin',
    author: { name: 'Test' }
  }, null, 2)}\n`,
  'skills/helper/SKILL.md': '---\nname: helper\ndescription: Helps with demos\n---\n\n# Helper\n',
  'mcp.json': `${JSON.stringify({
    mcpServers: {
      demo: {
        type: 'stdio',
        command: '${PLUGIN_ROOT}/scripts/run.sh',
        args: ['--data', '${PLUGIN_DATA}']
      }
    }
  }, null, 2)}\n`
});
const RUN_SCRIPT = '#!/bin/sh\necho demo\n';
const HELLO_PROMPT = '---\ndescription: Say hello\n---\n\nSay hello.\n';

/**
 * Write a fixture bundle archive built in-process.
 * @param dir - Existing directory the archive is written to.
 * @param kind - Bundle content.
 * @param opts - Version and manifest MCP servers.
 * @returns The archive path and bytes.
 */
export const writePluginBundleZip = (dir: string, kind: PluginBundleKind, opts: PluginBundleZipOptions = {}): PluginBundleZip => {
  const version = opts.version ?? '1.0.0';
  const prompts: Record<string, string>[] = [];
  const zip = new AdmZip();
  if (kind !== 'prompt') {
    prompts.push({
      id: DEMO_PLUGIN_ID,
      name: DEMO_PLUGIN_ID,
      description: 'Demo plugin',
      file: `${PLUGIN_DIR}/plugin.json`,
      type: 'plugin'
    });
  }
  if (kind !== 'plugin') {
    prompts.push({ id: 'hello', name: 'hello', description: 'Say hello', file: 'prompts/hello.prompt.md', type: 'prompt' });
  }
  const manifest: Record<string, unknown> = {
    id: DEMO_PLUGIN_ID,
    version,
    name: 'Demo Plugin',
    description: 'Demo plugin bundle',
    author: 'Test',
    tags: [],
    environments: ['vscode'],
    license: 'MIT',
    repository: '',
    prompts,
    dependencies: []
  };
  if (opts.withMcpServers === true) {
    manifest.mcpServers = { demo: { type: 'stdio', command: 'node', args: ['server.js'] } };
  }
  zip.addFile('deployment-manifest.yml', Buffer.from(yaml.dump(manifest), 'utf8'), '', REGULAR_ATTR);
  if (kind !== 'prompt') {
    for (const [file, content] of Object.entries(pluginFiles(version))) {
      zip.addFile(`${PLUGIN_DIR}/${file}`, Buffer.from(content, 'utf8'), '', REGULAR_ATTR);
    }
    zip.addFile(`${PLUGIN_DIR}/scripts/run.sh`, Buffer.from(RUN_SCRIPT, 'utf8'), '', EXECUTABLE_ATTR);
  }
  if (kind !== 'plugin') {
    zip.addFile('prompts/hello.prompt.md', Buffer.from(HELLO_PROMPT, 'utf8'), '', REGULAR_ATTR);
  }
  const bytes = zip.toBuffer();
  const zipPath = path.join(dir, `${DEMO_PLUGIN_ID}-${kind}-${version}.bundle.zip`);
  fs.writeFileSync(zipPath, bytes);
  return { zipPath, bytes };
};

/**
 * Build a fixture bundle with the real CLI in a fresh git repository.
 * @param workDir - Existing, empty test-owned directory.
 * @param kind - `plugin` or `mixed` (`prompt` has no plugin to create).
 * @returns The archive and its extraction (modes kept).
 */
export const buildPluginBundleWithCli = async (workDir: string, kind: Exclude<PluginBundleKind, 'prompt'>): Promise<CliBuiltPluginBundle> => {
  const home = path.join(workDir, 'home');
  const repo = path.join(workDir, 'collection-repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  runGit(repo, ['init', '-q']);
  runGit(repo, ['remote', 'add', 'origin', 'https://github.com/example/demo-plugin.git']);
  const cli = { cwd: repo, home };
  await runBuiltCliOk(['collection', 'create', DEMO_PLUGIN_ID, '--description', 'Demo plugin bundle', '--author', 'Test'], cli);
  await runBuiltCliOk(['plugin', 'create', DEMO_PLUGIN_ID, '--collection', DEMO_PLUGIN_ID, '--description', 'Demo plugin', '--author', 'Test'], cli);
  const pluginDir = path.join(repo, ...PLUGIN_DIR.split('/'));
  for (const [file, content] of Object.entries(pluginFiles('1.0.0'))) {
    if (file === 'plugin.json') {
      continue;
    }
    const target = path.join(pluginDir, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const runScript = path.join(pluginDir, 'scripts', 'run.sh');
  fs.mkdirSync(path.dirname(runScript), { recursive: true });
  fs.writeFileSync(runScript, RUN_SCRIPT);
  fs.chmodSync(runScript, 0o755);
  const collectionFile = `collections/${DEMO_PLUGIN_ID}.collection.yml`;
  if (kind === 'mixed') {
    // `prompt create <name>` names the file prompts/prompt.md whatever the
    // name, so the prompt is added by hand, after the plugin item.
    fs.mkdirSync(path.join(repo, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'prompts', 'hello.prompt.md'), HELLO_PROMPT);
    const collectionPath = path.join(repo, ...collectionFile.split('/'));
    const collection = yaml.load(fs.readFileSync(collectionPath, 'utf8')) as { items: Record<string, string>[] };
    collection.items.push({ path: 'prompts/hello.prompt.md', kind: 'prompt', name: 'hello', description: 'Say hello' });
    fs.writeFileSync(collectionPath, yaml.dump(collection));
  }
  await runBuiltCliOk(['collection', 'validate', '--collection-file', collectionFile], cli);
  runGit(repo, ['add', '-A']);
  runGit(repo, ['commit', '-q', '-m', 'demo plugin']);
  await runBuiltCliOk(['bundle', 'build', '--collection-file', collectionFile, '--version', '1.0.0', '--out-dir', 'dist'], cli);
  const zipPath = path.join(repo, 'dist', DEMO_PLUGIN_ID, `${DEMO_PLUGIN_ID}.bundle.zip`);
  const unpackedDir = path.join(workDir, `${DEMO_PLUGIN_ID}-${kind}`);
  new AdmZip(zipPath).extractAllTo(unpackedDir, true, true);
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(unpackedDir, ...PLUGIN_DIR.split('/'), 'scripts', 'run.sh'), 0o755);
  }
  return { zipPath, unpackedDir };
};
