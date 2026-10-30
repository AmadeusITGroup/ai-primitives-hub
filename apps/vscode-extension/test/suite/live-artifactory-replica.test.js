/* global require, process, setTimeout, suite, test -- Node and Mocha globals in the VS Code extension host. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

function assertLiveTestSettings(config) {
  const maximumWaits = new Map([
    ['observeMs', 300000],
    ['sourceSyncWaitMs', 30000]
  ]);
  for (const [name, value] of Object.entries(config)) {
    if (name === 'token') {
      continue;
    }
    const maximum = maximumWaits.get(name);
    if (maximum !== undefined) {
      assert.ok(
        Number.isInteger(value) && value >= 0 && value <= maximum,
        `Live test setting ${name} must be an integer from 0 to ${maximum}.`
      );
      continue;
    }
    assert.ok(value, `Live test setting ${name} is required.`);
  }
}

suite('Live Artifactory replica consumer', () => {
  test('accepts zero wait settings', () => {
    assert.doesNotThrow(() => assertLiveTestSettings({
      root: 'https://artifactory.example.test',
      configFile: 'hub-config.yml',
      profileId: 'sample-profile',
      hubId: 'sample-hub',
      sourceSyncWaitMs: 0,
      expectedFile: '/tmp/aph-live/home/installed.instructions.md',
      token: undefined,
      credentialRef: 'APH_LIVE_TOKEN',
      observeMs: 0
    }));
  });

  test('imports a configured hub and installs a selected profile', async function () {
    this.timeout(10 * 60 * 1000);

    const config = {
      root: process.env.APH_LIVE_ARTIFACTORY_ROOT,
      configFile: process.env.APH_LIVE_ARTIFACTORY_CONFIG_FILE,
      profileId: process.env.APH_LIVE_PROFILE_ID,
      hubId: process.env.APH_LIVE_HUB_ID,
      sourceSyncWaitMs: Number(process.env.APH_LIVE_SOURCE_SYNC_WAIT_MS || '5000'),
      expectedFile: path.resolve(
        process.env.HOME,
        process.env.APH_LIVE_VSCODE_EXPECTED_FILE
      ),
      token: process.env.APH_LIVE_ARTIFACTORY_TOKEN,
      credentialRef: process.env.APH_LIVE_ARTIFACTORY_CREDENTIAL_REF,
      observeMs: Number(process.env.APH_LIVE_OBSERVE_MS || '15000')
    };

    assertLiveTestSettings(config);
    assert.ok(
      config.expectedFile.startsWith(`${path.resolve(process.env.HOME)}${path.sep}`),
      'The expected install file must remain inside the isolated HOME.'
    );

    const originalQuickPick = vscode.window.showQuickPick;
    const originalInputBox = vscode.window.showInputBox;
    const availableProfile = (items) => items.find((item) => item.profileId === config.profileId);

    vscode.window.showQuickPick = async (items, options = {}) => {
      if (options.placeHolder === 'Select hub source type') {
        return items.find((item) => item.value === 'artifactory');
      }
      if (options.placeHolder === 'Artifactory authentication') {
        return config.token ? 'bearer' : 'anonymous';
      }
      if (/^Select (?:a )?profile to activate/u.test(options.placeHolder || '')) {
        const selected = availableProfile(items);
        assert.ok(selected, `Profile "${config.profileId}" was not offered by the imported hub.`);
        return selected;
      }
      throw new Error(`Unexpected Quick Pick during live test: ${options.placeHolder || options.title || 'unknown prompt'}`);
    };

    vscode.window.showInputBox = async (options = {}) => {
      if (options.prompt?.startsWith('Enter the Artifactory repository root')) {
        return config.root;
      }
      if (options.prompt?.startsWith('Hub config path relative')) {
        return config.configFile;
      }
      if (options.prompt?.startsWith('Enter hub ID')) {
        return config.hubId;
      }
      if (options.prompt?.startsWith('Credential label for VS Code SecretStorage')) {
        return config.credentialRef;
      }
      if (options.prompt?.startsWith('Paste the Artifactory access token')) {
        return config.token;
      }
      throw new Error(`Unexpected input box during live test: ${options.prompt || options.placeHolder || 'unknown prompt'}`);
    };

    try {
      const importedHubId = await vscode.commands.executeCommand('promptregistry.importHub');
      assert.equal(importedHubId, config.hubId, 'The configured Artifactory hub should be imported.');

      await vscode.commands.executeCommand('promptregistry.syncHub', importedHubId);
      await new Promise((resolve) => setTimeout(resolve, config.sourceSyncWaitMs));
      void vscode.window.showInformationMessage(
        'Live replica test: hub imported. Opening Marketplace and Registry Explorer before profile installation.'
      );
      await vscode.commands.executeCommand('workbench.view.extension.promptRegistry');
      await vscode.commands.executeCommand('promptregistry.activateHubProfile');
      await vscode.commands.executeCommand('workbench.view.extension.promptRegistry');

      const installed = await fs.stat(config.expectedFile).catch(() => undefined);
      assert.ok(installed?.isFile(), `Expected installed file was not found: ${config.expectedFile}`);
      assert.ok(installed.size > 0, `Expected installed file is empty: ${config.expectedFile}`);
      void vscode.window.showInformationMessage(
        `Live replica test passed: "${config.profileId}" installed. Marketplace and Registry Explorer are available in the AI Primitives Hub view.`
      );
      await new Promise((resolve) => setTimeout(resolve, config.observeMs));
    } finally {
      vscode.window.showQuickPick = originalQuickPick;
      vscode.window.showInputBox = originalInputBox;
    }
  });
});
