/**
 * Behavioral tests for the Marketplace webview.
 *
 * These tests execute the real webview JavaScript against a DOM instead of
 * only checking that source strings are present.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  JSDOM,
} from 'jsdom';
import {
  suite,
  test,
} from 'mocha';

const MARKETPLACE_DIR = path.join(
  process.cwd(),
  'src',
  'ui',
  'webview',
  'marketplace'
);

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

interface WebviewHarness {
  dom: JSDOM;
  messages: PostedMessage[];
}

const makeBundle = () => ({
  id: 'source/bundle@1.0.0',
  name: 'Test Bundle',
  version: '1.0.0',
  description: 'A bundle used by Marketplace webview tests',
  author: 'Test Author',
  sourceId: 'source',
  tags: ['alpha', 'beta', 'gamma'],
  environments: ['vscode'],
  installed: false,
  buttonState: 'install',
  contentBreakdown: {
    prompts: 1,
    instructions: 0,
    agents: 0,
    skills: 0,
    mcpServers: 0
  }
});

const createHarness = (): WebviewHarness => {
  const htmlPath = path.join(MARKETPLACE_DIR, 'marketplace.html');
  const scriptPath = path.join(MARKETPLACE_DIR, 'marketplace.js');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const messages: PostedMessage[] = [];
  const documentHtml = html.replace(
    /<script[^>]*src="\{\{scriptUri\}\}"[^>]*><\/script>/,
    '<script>' + script + '</script>'
  );

  const dom = new JSDOM(documentHtml, {
    runScripts: 'dangerously',
    beforeParse: (window) => {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (message: PostedMessage) => {
          messages.push(message);
        }
      });
    }
  });

  return { dom, messages };
};

const loadBundles = (harness: WebviewHarness): void => {
  harness.dom.window.dispatchEvent(new harness.dom.window.MessageEvent('message', {
    data: {
      type: 'bundlesLoaded',
      bundles: [makeBundle()],
      filterOptions: {
        tags: ['alpha', 'beta', 'gamma'],
        sources: [],
        environments: []
      },
      setupState: 'complete',
      sourcesCount: 1
    }
  }));
};

suite('Marketplace webview behavior', () => {
  test('updates the tag selector and checkboxes when an active tag is removed', () => {
    const harness = createHarness();
    try {
      loadBundles(harness);
      const { document } = harness.dom.window;

      (document.querySelector('#tagSelectorBtn') as unknown as { click: () => void }).click();
      document.querySelectorAll('.tag-item').forEach((item) => {
        (item as unknown as { click: () => void }).click();
      });

      assert.strictEqual(document.querySelector('#tagSelectorText')?.textContent, '3 tags');
      assert.strictEqual(document.querySelectorAll('.filter-chip').length, 3);

      (document.querySelector('[data-filter="tag"][data-value="beta"]') as unknown as { click: () => void }).click();

      assert.strictEqual(document.querySelector('#tagSelectorText')?.textContent, '2 tags');
      assert.strictEqual(document.querySelectorAll('.filter-chip').length, 2);
      assert.strictEqual((document.querySelector('#tag-beta') as unknown as { checked: boolean })?.checked, false);
      assert.strictEqual((document.querySelector('#tag-alpha') as unknown as { checked: boolean })?.checked, true);
      assert.strictEqual((document.querySelector('#tag-gamma') as unknown as { checked: boolean })?.checked, true);
    } finally {
      harness.dom.window.close();
    }
  });

  test('keeps Details and Repository actions functional and renders tab empty states', () => {
    const harness = createHarness();
    try {
      loadBundles(harness);
      const { document } = harness.dom.window;

      const detailsButton = document.querySelector('.details-button') as unknown as { click: () => void };
      const repositoryButton = document.querySelector('.source-repo-button') as unknown as {
        click: () => void;
        getAttribute: (name: string) => string | null;
      };
      assert.ok(detailsButton);
      assert.ok(repositoryButton);
      assert.strictEqual(repositoryButton.getAttribute('aria-label'), 'Open Source Repository');

      detailsButton.click();
      repositoryButton.click();
      assert.ok(harness.messages.some((message) => message.type === 'openDetails'));
      assert.ok(harness.messages.some((message) => message.type === 'openSourceRepository'));

      (document.querySelector('[data-tab="installed"]') as unknown as { click: () => void }).click();
      assert.match(document.querySelector('#marketplace')?.textContent ?? '', /No installed bundles/);

      (document.querySelector('[data-tab="updates"]') as unknown as { click: () => void }).click();
      assert.match(document.querySelector('#marketplace')?.textContent ?? '', /All installed bundles are up to date/);
    } finally {
      harness.dom.window.close();
    }
  });
});
