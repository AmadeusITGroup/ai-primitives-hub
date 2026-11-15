/** Contract tests for MCP servers owned by install record entries, on a real temp git folder. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type InstallRecord,
  type RecordedMcpServer,
  type RecordLocation,
} from '@ai-primitives-hub/core';
import {
  NodeRecordFs,
  RecordSchemaValidator,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  fromRecordFile,
  InstallRecordService,
  mcpServerChecksumOf,
  prepareMcpServers,
  RecordStore,
  writeMcpServers,
} from '../../src/records';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const BUNDLE = 'acme-tools-coll-1.0.0';
const CONFIG = '.vscode/mcp.json';
const KEY = 'ai-primitives-hub:acme:tools:coll';

describe('MCP servers in the install record', () => {
  let base: string;
  let root: string;
  let service: InstallRecordService;
  let committed: RecordLocation;
  const recordFs = new NodeRecordFs();

  const configPath = (relative = CONFIG): string => path.join(root, ...relative.split('/'));
  const readConfig = (relative = CONFIG): Record<string, any> => JSON.parse(fs.readFileSync(configPath(relative), 'utf8')) as Record<string, any>;
  const writeConfig = (value: unknown, relative = CONFIG): void => {
    fs.mkdirSync(path.dirname(configPath(relative)), { recursive: true });
    fs.writeFileSync(configPath(relative), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  const read = (): InstallRecord => fromRecordFile(JSON.parse(fs.readFileSync(committed.path, 'utf8')) as InstallRecord);

  const serversOf = (servers: Record<string, unknown>, version = '1.0.0'): ReturnType<typeof prepareMcpServers> => prepareMcpServers({
    servers, bundleId: `acme-tools-coll-${version}`, version, manifestId: 'coll', manifestRepository: 'https://github.com/acme/tools', bundlePath: root
  });

  // Write the servers as an install does, then record the entry that owns them.
  const install = async (
    tool: string,
    servers: Record<string, unknown>,
    options: { version?: string; relative?: string; serversKey?: 'servers' | 'mcpServers' } = {}
  ): Promise<RecordedMcpServer[]> => {
    const version = options.version ?? '1.0.0';
    const relative = options.relative ?? CONFIG;
    const listed = new Set(Object.values(read().bundles ?? {}).flatMap((bundle) => Object.values(bundle.tools)
      .flatMap((entry) => (entry.mcpServers ?? []).filter((server) => server.config === relative).map((server) => server.name))));
    const written = await writeMcpServers(recordFs, { path: configPath(relative), serversKey: options.serversKey ?? 'servers' }, serversOf(servers, version), {
      isRecorded: (name) => listed.has(name), label: relative
    });
    const mcpServers = written.map((server) => ({ ...server, config: relative }));
    const prompt = path.join(root, '.github', 'prompts', `${tool}-${version}.prompt.md`);
    fs.mkdirSync(path.dirname(prompt), { recursive: true });
    fs.writeFileSync(prompt, `${tool} ${version}\n`);
    const change = await service.recordInstall({
      location: committed, bundleId: `acme-tools-coll-${version}`, version, tool,
      source: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools' }, sourceType: 'github',
      writtenPaths: [prompt], mcpServers
    });
    await service.deleteSuperseded(change);
    return mcpServers;
  };

  beforeEach(async () => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'record-mcp-')));
    root = path.join(base, 'repo');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const store = new RecordStore({ fs: recordFs, validator: new RecordSchemaValidator(), generatedBy: 'ai-primitives-hub-cli@0.3.0', now: () => NOW });
    service = new InstallRecordService({ store, fs: recordFs, now: () => NOW });
    [committed] = await store.resolveRepository({ start: root });
    fs.writeFileSync(committed.path, JSON.stringify({
      $schema: 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json',
      version: '3.0.0', level: 'repository', generatedAt: NOW.toISOString(), generatedBy: 'test', sources: {}, bundles: {}
    }));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('names servers as the extension does and fills in the bundle placeholders, keeping ${env:VAR} unresolved', () => {
    const [server] = prepareMcpServers({
      servers: { db: { command: '${bundlePath}/run.sh', args: ['${bundleId}', '${bundleVersion}'], env: { TOKEN: '${env:DB_TOKEN}' } } },
      bundleId: 'acme-tools-coll-1.0.0', version: '1.0.0', manifestId: 'coll', manifestRepository: 'https://github.com/acme/tools', bundlePath: '/b',
      envPlaceholderStyle: 'bare'
    });

    expect(server).toEqual({
      name: `${KEY}:db`, item: 'db', definition: { command: '/b/run.sh', args: ['acme-tools-coll-1.0.0', '1.0.0'], env: { TOKEN: '${DB_TOKEN}' } }
    });
  });

  it('records each server with its file, name, item and checksum, and keeps the file\'s other servers and keys', async () => {
    writeConfig({ inputs: [{ id: 'tok', type: 'promptString' }], servers: { mine: { command: 'my-server' } } });

    await install('vscode', { db: { command: 'db-server' } });

    expect(read().bundles[BUNDLE].tools.vscode.mcpServers).toEqual([
      { config: CONFIG, name: `${KEY}:db`, item: 'db', checksum: mcpServerChecksumOf({ command: 'db-server' }) }
    ]);
    expect(readConfig()).toEqual({
      inputs: [{ id: 'tok', type: 'promptString' }],
      servers: { mine: { command: 'my-server' }, [`${KEY}:db`]: { command: 'db-server' } }
    });
  });

  it('uninstall removes only the entry\'s servers, keeps one changed since the install, and keeps the file with the user\'s servers', async () => {
    writeConfig({ servers: { mine: { command: 'my-server' } } });
    await install('vscode', { db: { command: 'db-server' }, cache: { command: 'cache-server' } });
    const edited = readConfig();
    edited.servers[`${KEY}:cache`].args = ['--port', '9000'];
    writeConfig(edited);

    const result = await service.uninstallEntry({ location: committed, bundleId: BUNDLE, tool: 'vscode' });

    expect(result.mcpServersRemoved.map((server) => server.name)).toEqual([`${KEY}:db`]);
    expect(result.mcpServersModified.map((server) => server.name)).toEqual([`${KEY}:cache`]);
    expect(Object.keys(readConfig().servers).toSorted()).toEqual([`${KEY}:cache`, 'mine']);
  });

  it('a tool turning a server off is not a change of the definition', async () => {
    await install('vscode', { db: { command: 'db-server' } });
    const disabled = readConfig();
    disabled.servers[`${KEY}:db`].disabled = true;
    writeConfig(disabled);

    await service.uninstallEntry({ location: committed, bundleId: BUNDLE, tool: 'vscode' });

    // Nothing but the empty server map was left, so the file the install created is gone.
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('keeps a file left with an empty server map when it has other keys', async () => {
    writeConfig({ inputs: [] });
    await install('vscode', { db: { command: 'db-server' } });

    await service.uninstallEntry({ location: committed, bundleId: BUNDLE, tool: 'vscode' });

    expect(readConfig()).toEqual({ inputs: [], servers: {} });
  });

  it('an update removes a server the new version dropped and rewrites the one it keeps under the same name', async () => {
    await install('vscode', { db: { command: 'db-1' }, cache: { command: 'cache-1' } });

    await install('vscode', { db: { command: 'db-2' } }, { version: '2.0.0' });

    expect(readConfig().servers).toEqual({ [`${KEY}:db`]: { command: 'db-2' } });
    expect(read().bundles['acme-tools-coll-2.0.0'].tools.vscode.mcpServers?.map((server) => server.name)).toEqual([`${KEY}:db`]);
  });

  it('a reinstall without MCP servers given keeps the servers the entry recorded', async () => {
    const recorded = await install('vscode', { db: { command: 'db-server' } });
    const prompt = path.join(root, '.github', 'prompts', 'again.prompt.md');
    fs.writeFileSync(prompt, 'again\n');

    const change = await service.recordInstall({
      location: committed, bundleId: BUNDLE, version: '1.0.0', tool: 'vscode',
      source: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools' }, sourceType: 'github', writtenPaths: [prompt]
    });

    expect(change.removedMcpServers).toBeUndefined();
    expect(read().bundles[BUNDLE].tools.vscode.mcpServers).toEqual(recorded);
  });

  it('a server two tools record in one file stays until the last of them is uninstalled', async () => {
    const kiro = '.kiro/settings/mcp.json';
    await install('kiro', { db: { command: 'db-server' } }, { relative: kiro, serversKey: 'mcpServers' });
    await install('kiro-cli', { db: { command: 'db-server' } }, { relative: kiro, serversKey: 'mcpServers' });

    await service.uninstallEntry({ location: committed, bundleId: BUNDLE, tool: 'kiro' });
    expect(Object.keys(readConfig(kiro).mcpServers)).toEqual([`${KEY}:db`]);

    await service.uninstallEntry({ location: committed, bundleId: BUNDLE, tool: 'kiro-cli' });
    expect(fs.existsSync(configPath(kiro))).toBe(false);
  });

  it('refuses a server name the file already has that no install recorded, and leaves the file unchanged', async () => {
    writeConfig({ servers: { [`${KEY}:db`]: { command: 'hand-written' } } });
    const before = fs.readFileSync(configPath(), 'utf8');

    await expect(install('vscode', { db: { command: 'db-server' } })).rejects.toMatchObject({ code: 'RECORD.MCP_CONFLICT' });

    expect(fs.readFileSync(configPath(), 'utf8')).toBe(before);
  });

  it('refuses to write into an MCP file that is not plain JSON, and uninstall warns instead of rewriting it', async () => {
    await install('vscode', { db: { command: 'db-server' } });
    const commented = `// my servers\n${fs.readFileSync(configPath(), 'utf8')}`;
    writeConfig(commented);

    await expect(install('vscode', { db: { command: 'db-server' } }, { version: '2.0.0' })).rejects.toMatchObject({ code: 'RECORD.MCP_CONFIG_UNREADABLE' });
    const result = await service.uninstallEntry({ location: committed, bundleId: BUNDLE, tool: 'vscode' });

    expect(fs.readFileSync(configPath(), 'utf8')).toBe(commented);
    expect(result.warnings.join('\n')).toContain(`Did not remove the MCP servers of ${CONFIG}`);
  });

  it('never touches an MCP file the record places outside the level root', async () => {
    const outside = path.join(base, 'elsewhere.json');
    fs.writeFileSync(outside, JSON.stringify({ servers: { x: { command: 'x' } } }));

    const result = await service.removeRecordedMcpServers(root, [{ config: '../elsewhere.json', name: 'x' }]);

    expect(result.removed).toEqual([]);
    expect(result.warnings).toEqual([`Did not change ../elsewhere.json: it is outside ${root}.`]);
    expect(JSON.parse(fs.readFileSync(outside, 'utf8'))).toEqual({ servers: { x: { command: 'x' } } });
  });
});
