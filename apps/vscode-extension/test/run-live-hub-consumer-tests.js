/* global require, __dirname, module, process, URL -- Node globals used by the live campaign runner. */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const extensionPath = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(extensionPath, '../..');

function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    value = (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value.replace(/\s+#.*$/u, '').trim();
    values[match[1]] = value;
  }
  return values;
}

async function loadEnvFile() {
  const envFile = process.env.APH_LIVE_ENV_FILE || path.join(repositoryRoot, '.art.env');
  try {
    const content = await fs.readFile(envFile, 'utf8');
    for (const [name, value] of Object.entries(parseEnvFile(content))) {
      if (process.env[name] === undefined) {
        process.env[name] = value;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Could not read live-test env file "${envFile}": ${error.message}`);
    }
  }
}

async function promptForToken() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return undefined;
  }

  process.stdout.write('Artifactory read token (input hidden; Enter for anonymous): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise((resolve, reject) => {
    let token = '';
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          reject(new Error('Live test cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(token);
          return;
        }
        if (character === '\u007F' || character === '\b') {
          token = token.slice(0, -1);
        } else if (character >= ' ') {
          token += character;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function resolveToken() {
  if (process.env.APH_LIVE_ARTIFACTORY_AUTH === 'anonymous') {
    return undefined;
  }
  const configuredRef = process.env.APH_LIVE_ARTIFACTORY_CREDENTIAL_REF
    || 'ARTIFACTORY_READER_TOKEN';
  const existingToken = process.env.APH_LIVE_ARTIFACTORY_TOKEN
    || process.env[configuredRef]
    || process.env.ARTIFACTORY_READER_TOKEN;
  if (existingToken) {
    return existingToken;
  }
  const promptedToken = await promptForToken();
  if (promptedToken) {
    return promptedToken;
  }
  if (process.stdin.isTTY) {
    return undefined;
  }
  throw new Error(
    'No Artifactory token configured. Set APH_LIVE_ARTIFACTORY_TOKEN or ARTIFACTORY_READER_TOKEN in .art.env, or set APH_LIVE_ARTIFACTORY_AUTH=anonymous for a public hub.'
  );
}

function readConfig() {
  const root = process.env.APH_LIVE_ARTIFACTORY_ROOT;
  const profileId = process.env.APH_LIVE_PROFILE_ID;
  const cliExpectedFile = process.env.APH_LIVE_CLI_EXPECTED_FILE;
  const vscodeExpectedFile = process.env.APH_LIVE_VSCODE_EXPECTED_FILE;
  const token = process.env.APH_LIVE_ARTIFACTORY_TOKEN;
  const credentialRef = process.env.APH_LIVE_ARTIFACTORY_CREDENTIAL_REF
    || 'ARTIFACTORY_READER_TOKEN';

  const missing = [
    ['APH_LIVE_ARTIFACTORY_ROOT', root],
    ['APH_LIVE_PROFILE_ID', profileId],
    ['APH_LIVE_CLI_EXPECTED_FILE', cliExpectedFile],
    ['APH_LIVE_VSCODE_EXPECTED_FILE', vscodeExpectedFile]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required live-test settings: ${missing.join(', ')}`);
  }

  const parsedRoot = new URL(root);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsedRoot.hostname);
  if (parsedRoot.protocol !== 'https:' && !(parsedRoot.protocol === 'http:' && loopback)) {
    throw new Error('APH_LIVE_ARTIFACTORY_ROOT must use HTTPS (or loopback HTTP for local testing).');
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(credentialRef)) {
    throw new Error('APH_LIVE_ARTIFACTORY_CREDENTIAL_REF must be an uppercase environment-variable name.');
  }

  const observeMs = Number(process.env.APH_LIVE_OBSERVE_MS || '15000');
  if (!Number.isInteger(observeMs) || observeMs < 0 || observeMs > 3e5) {
    throw new Error('APH_LIVE_OBSERVE_MS must be an integer from 0 to 300000.');
  }
  const sourceSyncWaitMs = Number(process.env.APH_LIVE_SOURCE_SYNC_WAIT_MS || '5000');
  if (!Number.isInteger(sourceSyncWaitMs) || sourceSyncWaitMs < 0 || sourceSyncWaitMs > 3e4) {
    throw new Error('APH_LIVE_SOURCE_SYNC_WAIT_MS must be an integer from 0 to 30000.');
  }

  return {
    root: root.replace(/\/+$/, ''),
    configFile: process.env.APH_LIVE_ARTIFACTORY_CONFIG_FILE || '__CONFIG__/hub-config.yml',
    profileId,
    cliExpectedFile,
    vscodeExpectedFile,
    token,
    credentialRef,
    observeMs,
    sourceSyncWaitMs,
    hubId: process.env.APH_LIVE_HUB_ID || 'live-artifactory-replica'
  };
}

function resolveExpectedFile(basePath, relativePath, label) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative to its isolated install directory.`);
  }
  const resolved = path.resolve(basePath, relativePath);
  const relative = path.relative(basePath, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must not escape its isolated install directory.`);
  }
  return resolved;
}

function runCli(cliPath, args, options) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error || result.status !== 0) {
    const safeOutput = options.token
      ? output.replaceAll(options.token, '[REDACTED]')
      : output;
    throw new Error(
      `CLI command failed (exit ${String(result.status)}): ${args.join(' ')}\n${safeOutput}`
    );
  }
}

async function assertFileExists(filePath, label) {
  let fileStat;
  try {
    fileStat = await fs.stat(filePath);
  } catch {
    throw new Error(`${label} did not install the expected file: ${filePath}`);
  }
  assert.ok(fileStat.isFile(), `${label} expected path is not a file: ${filePath}`);
  assert.ok(fileStat.size > 0, `${label} installed an empty file: ${filePath}`);
}

async function runCliConsumer(config, runRoot) {
  const home = path.join(runRoot, 'cli-home');
  const cwd = path.join(runRoot, 'cli-workspace');
  const targetPath = path.join(runRoot, 'cli-target');
  const cliPath = path.join(repositoryRoot, 'packages/cli/bin/ai-primitives-hub.js');
  const expectedFile = resolveExpectedFile(targetPath, config.cliExpectedFile, 'APH_LIVE_CLI_EXPECTED_FILE');
  const credentialRef = config.token ? config.credentialRef : undefined;

  await Promise.all([home, cwd, targetPath].map((directory) =>
    fs.mkdir(directory, { recursive: true })
  ));

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache')
  };
  if (credentialRef && config.token) {
    env[credentialRef] = config.token;
  }

  const commonArgs = [
    '--type', 'artifactory',
    '--location', config.root,
    '--config-file', config.configFile,
    '--id', config.hubId,
    ...(credentialRef ? ['--auth', 'bearer', '--credential-ref', credentialRef] : ['--auth', 'anonymous']),
    '--output', 'json'
  ];

  runCli(cliPath, ['hub', 'add', ...commonArgs], { cwd, env, token: config.token });
  runCli(cliPath, [
    'target', 'add', 'live-copilot',
    '--type', 'copilot-cli',
    '--scope', 'user',
    '--path', targetPath,
    '--output', 'json'
  ], { cwd, env, token: config.token });
  runCli(cliPath, [
    'profile', 'activate', config.profileId,
    '--hub', config.hubId,
    '--target', 'live-copilot',
    '--output', 'json'
  ], { cwd, env, token: config.token });

  await assertFileExists(expectedFile, 'CLI');
  process.stdout.write('PASS: CLI imported the Artifactory hub and installed the configured profile.\n');
}

async function runVsCodeConsumer(config, runRoot) {
  const vscodeRoot = path.join(runRoot, 'vscode');
  const home = path.join(vscodeRoot, 'home');
  const userData = path.join(vscodeRoot, 'user-data');
  const extensions = path.join(vscodeRoot, 'extensions');
  const expectedFile = resolveExpectedFile(home, config.vscodeExpectedFile, 'APH_LIVE_VSCODE_EXPECTED_FILE');

  await Promise.all([home, userData, extensions].map((directory) =>
    fs.mkdir(directory, { recursive: true })
  ));

  const savedEnvironment = new Map(
    ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
      .map((name) => [name, process.env[name]])
  );
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(vscodeRoot, 'config');
  process.env.XDG_DATA_HOME = path.join(vscodeRoot, 'data');
  process.env.XDG_CACHE_HOME = path.join(vscodeRoot, 'cache');
  process.env.APH_LIVE_ARTIFACTORY_ROOT = config.root;
  process.env.APH_LIVE_ARTIFACTORY_CONFIG_FILE = config.configFile;
  process.env.APH_LIVE_PROFILE_ID = config.profileId;
  process.env.APH_LIVE_HUB_ID = config.hubId;
  process.env.APH_LIVE_VSCODE_EXPECTED_FILE = config.vscodeExpectedFile;
  process.env.APH_LIVE_ARTIFACTORY_CREDENTIAL_REF = config.credentialRef;
  if (config.token) {
    process.env.APH_LIVE_ARTIFACTORY_TOKEN = config.token;
  } else {
    delete process.env.APH_LIVE_ARTIFACTORY_TOKEN;
  }

  const testOptions = {
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: path.join(extensionPath, 'test/suite/live-artifactory-replica-index.js'),
    launchArgs: [
      '--user-data-dir', userData,
      '--extensions-dir', extensions,
      '--disable-extensions',
      '--disable-gpu',
      '--no-sandbox'
    ]
  };
  if (process.env.VSCODE_EXECUTABLE_PATH) {
    testOptions.vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
  }

  try {
    await runTests(testOptions);
    await assertFileExists(expectedFile, 'VS Code');
    process.stdout.write('PASS: VS Code imported the Artifactory hub and installed the configured profile.\n');
  } finally {
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    for (const name of [
      'APH_LIVE_ARTIFACTORY_ROOT',
      'APH_LIVE_ARTIFACTORY_CONFIG_FILE',
      'APH_LIVE_PROFILE_ID',
      'APH_LIVE_HUB_ID',
      'APH_LIVE_VSCODE_EXPECTED_FILE',
      'APH_LIVE_ARTIFACTORY_CREDENTIAL_REF',
      'APH_LIVE_ARTIFACTORY_TOKEN'
    ]) {
      delete process.env[name];
    }
  }
}

async function main() {
  let runRoot;
  try {
    await loadEnvFile();
    const config = readConfig();
    config.token = await resolveToken();
    if (config.token) {
      process.env.APH_LIVE_ARTIFACTORY_TOKEN = config.token;
    }
    runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aph-live-replica-consumers-'));
    await runCliConsumer(config, runRoot);
    await runVsCodeConsumer(config, runRoot);
    process.stdout.write('Live replica consumer campaign passed.\n');
  } finally {
    if (runRoot) {
      await fs.rm(runRoot, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { resolveToken };
