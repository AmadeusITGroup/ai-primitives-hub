/**
 * Parity between the two deliveries of collection validation: the
 * `promptRegistry.validateCollections` command handler and
 * `ai-primitives-hub collection validate`, run as the real CLI built from
 * this checkout, report the same findings for the same workspace.
 */
import * as assert from 'node:assert';
import {
  spawnSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import {
  runValidateCollections,
} from '../helpers/collection-validator-test-helpers';
import {
  rmrfSync,
} from '../helpers/e2e-test-helpers';
import {
  workspaceRoot,
} from '../helpers/workspace-pack-helpers';

const CLI_BIN = path.join(workspaceRoot, 'packages', 'cli', 'bin', 'ai-primitives-hub.js');
const CLI_DIST = path.join(workspaceRoot, 'packages', 'cli', 'dist');

interface CliValidateEnvelope {
  data: { ok: boolean; errors: string[]; warnings: string[] };
}

/**
 * Run the built CLI in a directory.
 * @param cwd - Working directory
 * @param args - CLI arguments
 * @returns Exit status and stdout
 */
function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], { cwd, encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Run the built CLI and require a zero exit status.
 * @param cwd - Working directory
 * @param args - CLI arguments
 */
function runCliOk(cwd: string, args: string[]): void {
  const result = runCli(cwd, args);
  assert.strictEqual(result.status, 0, `ai-primitives-hub ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
}

/**
 * Run `collection validate -o json` and return its data.
 * @param cwd - Workspace directory
 * @returns The JSON envelope data
 */
function cliValidate(cwd: string): CliValidateEnvelope['data'] {
  const { stdout } = runCli(cwd, ['collection', 'validate', '-o', 'json']);
  return (JSON.parse(stdout) as CliValidateEnvelope).data;
}

suite('E2E: collection validation parity between the command and the CLI', function () {
  this.timeout(60_000);

  let sandbox: sinon.SinonSandbox;
  let workspaceDir: string;

  suiteSetup(() => {
    if (!fs.existsSync(CLI_DIST)) {
      throw new Error(`The CLI is not built (${CLI_DIST} is missing): run pnpm -C packages -r build`);
    }
  });

  setup(() => {
    sandbox = sinon.createSandbox();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-validation-parity-'));
    runCliOk(workspaceDir, ['collection', 'create', 'demo', '--author', 'Jane Doe']);
    runCliOk(workspaceDir, ['plugin', 'create', 'demo-plugin', '--author', 'Jane Doe', '--collection', 'demo']);
  });

  teardown(() => {
    sandbox.restore();
    rmrfSync(workspaceDir);
  });

  test('a CLI-scaffolded collection has no errors and the same warnings in both deliveries', async () => {
    const cli = cliValidate(workspaceDir);
    assert.strictEqual(cli.ok, true, JSON.stringify(cli.errors));
    assert.deepStrictEqual(cli.errors, []);

    const run = await runValidateCollections(sandbox, workspaceDir);

    assert.deepStrictEqual(run.errors, []);
    assert.deepStrictEqual(run.warnings, cli.warnings);
  });

  test('an invalid Agent Plugin manifest yields the same errors in both deliveries', async () => {
    const manifestPath = path.join(workspaceDir, 'plugins', 'demo-plugin', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name: 'Not_Valid Name', author: 'plain-string' }, null, 2)}\n`);

    const cli = cliValidate(workspaceDir);
    const run = await runValidateCollections(sandbox, workspaceDir);

    assert.deepStrictEqual(run.errors, cli.errors);
    const prefix = 'collections/demo.collection.yml: items[0] plugin plugins/demo-plugin/plugin.json: ';
    const pluginErrors = run.errors.filter((error) => error.startsWith(prefix));
    assert.strictEqual(pluginErrors.length, 3, JSON.stringify(run.errors));
    assert.ok(pluginErrors.some((error) => error.includes('"name" must be 1-64 characters')), JSON.stringify(pluginErrors));
    assert.ok(pluginErrors.some((error) => error.includes('"author" must be an object')), JSON.stringify(pluginErrors));
    assert.ok(pluginErrors.some((error) => error.includes('must match its directory "demo-plugin"')), JSON.stringify(pluginErrors));
  });

  test('an unknown collection property is the same warning in both deliveries', async () => {
    fs.appendFileSync(path.join(workspaceDir, 'collections', 'demo.collection.yml'), 'license: MIT\n');

    const result = runCli(workspaceDir, ['collection', 'validate', '-o', 'json']);
    assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const cli = (JSON.parse(result.stdout) as CliValidateEnvelope).data;
    assert.strictEqual(cli.ok, true, JSON.stringify(cli.errors));
    assert.deepStrictEqual(cli.errors, []);
    const warning = 'collections/demo.collection.yml: unknown root property \'license\' is not in the collection schema; '
      + 'remove it or rename it to one of: id, name, description, items, mcp, readme, version, author, tags, display';
    assert.ok(cli.warnings.includes(warning), JSON.stringify(cli.warnings));

    const run = await runValidateCollections(sandbox, workspaceDir);

    assert.deepStrictEqual(run.errors, []);
    assert.deepStrictEqual(run.warnings, cli.warnings);
  });
});
