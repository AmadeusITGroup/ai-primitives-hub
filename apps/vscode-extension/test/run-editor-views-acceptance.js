/* global require, process, console, __dirname */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const extensionPath = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures', 'editor-views');
const tests = path.join(__dirname, 'acceptance', 'editor-views', 'index.js');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function main() {
  const executable = process.env.VSCODE_EXECUTABLE_PATH
    || ['/usr/share/code/code', '/usr/share/code-insiders/code-insiders'].find((candidate) => fs.existsSync(candidate));
  if (!executable || (process.platform === 'linux' && !process.env.DISPLAY)) {
    throw new Error('An installed VS Code and a display are required; set VSCODE_EXECUTABLE_PATH if necessary.');
  }
  if (!fs.existsSync(path.join(extensionPath, 'dist', 'extension.js'))) {
    throw new Error('Build the extension first with pnpm -C apps/vscode-extension run compile.');
  }

  const campaign = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-editor-views-'));
  const originalEnv = { ...process.env };
  try {
    for (const phase of ['hub', 'collection', 'empty']) {
      const root = path.join(campaign, phase);
      const workspace = path.join(root, 'workspace');
      const home = path.join(root, 'home');
      const userData = path.join(root, 'vscode-user-data');
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
      if (phase !== 'empty') {
        fs.cpSync(path.join(fixtures, phase), workspace, { recursive: true });
      }
      fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'workbench.enableExperiments': false,
        'security.workspace.trust.enabled': false
      }));
      const port = await availablePort();
      const env = {
        PATH: originalEnv.PATH, DISPLAY: originalEnv.DISPLAY, XAUTHORITY: originalEnv.XAUTHORITY,
        DBUS_SESSION_BUS_ADDRESS: originalEnv.DBUS_SESSION_BUS_ADDRESS, LANG: originalEnv.LANG,
        HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(root, 'xdg', 'config'),
        XDG_DATA_HOME: path.join(root, 'xdg', 'data'),
        XDG_STATE_HOME: path.join(root, 'xdg', 'state'),
        XDG_CACHE_HOME: path.join(root, 'xdg', 'cache'),
        APH_EDITOR_VIEW_PHASE: phase, APH_EDITOR_VIEW_PORT: String(port)
      };
      for (const key of Object.keys(process.env)) {
        delete process.env[key];
      }
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
          process.env[key] = value;
        }
      }
      console.log(`Testing ${phase} workspace in VS Code`);
      await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: extensionPath,
        extensionTestsPath: tests,
        launchArgs: [workspace, '--user-data-dir', userData, '--extensions-dir', path.join(root, 'extensions'),
          '--disable-extensions', '--disable-gpu', '--disable-updates', '--disable-telemetry',
          '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', `--remote-debugging-port=${port}`]
      });
    }
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(campaign, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
