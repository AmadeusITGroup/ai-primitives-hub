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

      await sleep(2000);
      if (phase !== 'hub') {
        // Reproduce a contributable active hub without accessing an external GitHub repository.
        await vscode.commands.executeCommand('setContext', 'promptRegistry.activeHubContributable', true);
        const contribute = page.locator('[aria-label^="Contribute to Hub (Fork, Clone & Open Visual Editor)"]');
        await contribute.waitFor({ state: 'attached', timeout: 30000 });
        await sleep(2000);
        const snapshot = await page.evaluate(() => {
          const visible = (element) => Boolean(element && element.getClientRects().length
            && getComputedStyle(element).visibility !== 'hidden');
          const headers = [...document.querySelectorAll('.pane-header')];
          return {
            contributable: Boolean(document.querySelector('[aria-label^="Contribute to Hub (Fork, Clone & Open Visual Editor)"]')),
            hub: visible(headers.find((header) => header.textContent.includes('Hub Configuration Editor'))),
            collection: visible(headers.find((header) => header.textContent.includes('Collections Editor')))
          };
        });
        assert.ok(snapshot.contributable, 'Contributable hub context should remain active');
        assert.equal(snapshot.hub, false, 'Hub editor visibility');
        assert.equal(snapshot.collection, phase === 'collection', 'Collection editor visibility');
      } else {
        assert.equal(await hub.isVisible(), true, 'Hub editor visibility');
        assert.equal(await collection.isVisible(), false, 'Collection editor visibility');
      }
    } finally {
      await browser.close();
    }
  });
});
