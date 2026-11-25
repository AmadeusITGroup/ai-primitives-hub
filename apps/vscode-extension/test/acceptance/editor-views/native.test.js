/* global require, process, suite, test, setTimeout */
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { chromium } = require('playwright');
const pkg = require('../../../package.json');

const phase = process.env.APH_EDITOR_VIEW_PHASE;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

suite(`editor views (${phase} workspace)`, () => {
  test('shows only the editor for the loaded workspace', async () => {
    const extension = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
    assert.ok(extension, 'Extension should be installed in the development host');
    await extension.activate();
    await vscode.commands.executeCommand('workbench.view.extension.promptRegistry');

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.APH_EDITOR_VIEW_PORT}`);
    try {
      const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('workbench'));
      assert.ok(page, 'VS Code workbench should be available');
      const hub = page.locator('.pane-header').filter({ hasText: 'Hub Configuration Editor' });
      const collection = page.locator('.pane-header').filter({ hasText: 'Collections Editor' });
      const expected = phase === 'hub' ? hub : phase === 'collection' ? collection : undefined;
      if (expected) {
        await expected.waitFor({ state: 'visible', timeout: 30000 });
        const fixtureName = phase === 'hub' ? 'Test Hub' : 'Test Collection';
        await page.getByText(fixtureName, { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 });
      }

      // Reproduce a contributable active hub without accessing an external GitHub repository.
      if (phase !== 'hub') {
        await vscode.commands.executeCommand('setContext', 'promptRegistry.activeHubContributable', true);
      }
      await sleep(2000);
      assert.equal(await hub.isVisible(), phase === 'hub', 'Hub editor visibility');
      assert.equal(await collection.isVisible(), phase === 'collection', 'Collection editor visibility');
    } finally {
      await browser.close();
    }
  });
});
