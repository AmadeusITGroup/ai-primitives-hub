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

/** The filter dropdowns sharing the single-open-at-a-time controller, with their triggers. */
const FILTER_DROPDOWNS = [
  { trigger: '#sourceSelectorBtn', dropdown: 'sourceDropdown' },
  { trigger: '#tagSelectorBtn', dropdown: 'tagDropdown' },
  { trigger: '#contentTypeSelectorBtn', dropdown: 'contentTypeDropdown' }
];

const visibleDropdowns = (harness: WebviewHarness): string[] => FILTER_DROPDOWNS
  .map(({ dropdown }) => dropdown)
  .filter((dropdown) => {
    const element = harness.dom.window.document.querySelector('#' + dropdown) as unknown as {
      style: { display: string };
    } | null;

    return element?.style.display === 'block';
  });

const pressEscape = (harness: WebviewHarness): void => {
  harness.dom.window.document.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true
  }));
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

  test('restores the unfiltered primitives state from the All primitives option', () => {
    const harness = createHarness();
    try {
      loadBundles(harness);
      const { document } = harness.dom.window;

      (document.querySelector('#contentType-agents') as unknown as { click: () => void }).click();
      (document.querySelector('#contentType-skills') as unknown as { click: () => void }).click();

      assert.strictEqual(document.querySelector('#contentTypeSelectorText')?.textContent, '2 types');
      assert.strictEqual(document.querySelectorAll('[data-filter="content"]').length, 2);
      // As with tags, the "All primitives" radio starts out checked, so assert it is
      // released here to keep the post-reset assertions meaningful.
      assert.strictEqual((document.querySelector('#contentType-all') as unknown as { checked: boolean })?.checked, false);
      assert.strictEqual(document.querySelector('.content-type-all')?.classList.contains('active'), false);

      (document.querySelector('.content-type-all') as unknown as { click: () => void }).click();

      assert.strictEqual(document.querySelector('#contentTypeSelectorText')?.textContent, 'Primitives');
      assert.strictEqual(document.querySelectorAll('[data-filter="content"]').length, 0);
      assert.strictEqual((document.querySelector('#contentType-all') as unknown as { checked: boolean })?.checked, true);
      assert.strictEqual(document.querySelector('.content-type-all')?.classList.contains('active'), true);
      assert.strictEqual((document.querySelector('#contentType-agents') as unknown as { checked: boolean })?.checked, false);
      assert.strictEqual((document.querySelector('#contentType-skills') as unknown as { checked: boolean })?.checked, false);
    } finally {
      harness.dom.window.close();
    }
  });

  test('restores the unfiltered tag state from the All tags option', () => {
    const harness = createHarness();
    try {
      loadBundles(harness);
      const { document } = harness.dom.window;

      (document.querySelector('#tagSelectorBtn') as unknown as { click: () => void }).click();
      document.querySelectorAll('.tag-item[data-tag]').forEach((item) => {
        (item as unknown as { click: () => void }).click();
      });

      assert.strictEqual(document.querySelector('#tagSelectorText')?.textContent, '3 tags');
      assert.strictEqual(document.querySelectorAll('[data-filter="tag"]').length, 3);
      // The "All tags" row must give up both its checked radio and its active styling
      // while individual tags are selected, otherwise the reset below proves nothing:
      // the radio starts out checked at render time.
      assert.strictEqual((document.querySelector('#tag-all') as unknown as { checked: boolean })?.checked, false);
      assert.strictEqual(document.querySelector('.tag-all')?.classList.contains('active'), false);

      (document.querySelector('.tag-all') as unknown as { click: () => void }).click();

      assert.strictEqual(document.querySelector('#tagSelectorText')?.textContent, 'Tags');
      assert.strictEqual(document.querySelectorAll('[data-filter="tag"]').length, 0);
      assert.strictEqual((document.querySelector('#tag-all') as unknown as { checked: boolean })?.checked, true);
      assert.strictEqual(document.querySelector('.tag-all')?.classList.contains('active'), true);
      assert.strictEqual((document.querySelector('#tag-alpha') as unknown as { checked: boolean })?.checked, false);
      assert.strictEqual((document.querySelector('#tag-beta') as unknown as { checked: boolean })?.checked, false);
      assert.strictEqual((document.querySelector('#tag-gamma') as unknown as { checked: boolean })?.checked, false);
      assert.strictEqual(document.querySelectorAll('.bundle-card').length, 1);
    } finally {
      harness.dom.window.close();
    }
  });

  test('clears search, tag and primitive filters together from the Clear action', () => {
    const harness = createHarness();
    try {
      loadBundles(harness);
      const { document } = harness.dom.window;
      const searchBox = document.querySelector('#searchBox') as unknown as {
        value: string;
        dispatchEvent: (event: Event) => boolean;
      };

      searchBox.value = 'bundle';
      searchBox.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
      (document.querySelector('.tag-item[data-tag="alpha"]') as unknown as { click: () => void }).click();
      (document.querySelector('#contentType-prompts') as unknown as { click: () => void }).click();

      assert.ok(document.querySelectorAll('[data-filter]').length > 0, 'filters should be active before clearing');

      (document.querySelector('#clearActiveFilters') as unknown as { click: () => void }).click();

      assert.strictEqual(searchBox.value, '');
      assert.strictEqual(document.querySelectorAll('[data-filter]').length, 0);
      assert.strictEqual(document.querySelector('#tagSelectorText')?.textContent, 'Tags');
      assert.strictEqual(document.querySelector('#contentTypeSelectorText')?.textContent, 'Primitives');
      assert.strictEqual(document.querySelector('#sourceSelectorText')?.textContent, 'Sources');
      // resetFilters resets state and lets updateFilterUI rebuild the rows, so the
      // rebuilt dropdown rows must come back unchecked and in their "All …" state.
      assert.strictEqual((document.querySelector('#tag-all') as unknown as { checked: boolean })?.checked, true);
      assert.strictEqual((document.querySelector('#tag-alpha') as unknown as { checked: boolean })?.checked, false);
      assert.strictEqual((document.querySelector('#contentType-all') as unknown as { checked: boolean })?.checked, true);
      assert.strictEqual((document.querySelector('#contentType-prompts') as unknown as { checked: boolean })?.checked, false);
      assert.strictEqual((document.querySelector('#source-all') as unknown as { checked: boolean })?.checked, true);
      assert.strictEqual(document.querySelectorAll('.tag-item.hidden').length, 0, 'tag search filtering should be undone');
      assert.strictEqual(document.querySelectorAll('.bundle-card').length, 1);
    } finally {
      harness.dom.window.close();
    }
  });

  test('keeps the Source, Tags and Primitives dropdowns mutually exclusive', () => {
    const harness = createHarness();
    try {
      loadBundles(harness);
      const { document } = harness.dom.window;

      FILTER_DROPDOWNS.forEach(({ trigger, dropdown }) => {
        (document.querySelector(trigger) as unknown as { click: () => void }).click();

        assert.deepStrictEqual(visibleDropdowns(harness), [dropdown], 'only ' + dropdown + ' should be visible');
        FILTER_DROPDOWNS.forEach((candidate) => {
          assert.strictEqual(
            document.querySelector(candidate.trigger)?.getAttribute('aria-expanded'),
            String(candidate.dropdown === dropdown),
            candidate.trigger + ' aria-expanded should track its own dropdown'
          );
        });
      });
    } finally {
      harness.dom.window.close();
    }
  });

  test('collapses an open filter dropdown when its own trigger is clicked again', () => {
    const harness = createHarness();
    try {
      loadBundles(harness);
      const { document } = harness.dom.window;
      const tagTrigger = document.querySelector('#tagSelectorBtn') as unknown as { click: () => void };

      tagTrigger.click();
      assert.deepStrictEqual(visibleDropdowns(harness), ['tagDropdown']);

      tagTrigger.click();

      assert.deepStrictEqual(visibleDropdowns(harness), []);
      assert.strictEqual(document.querySelector('#tagSelectorBtn')?.getAttribute('aria-expanded'), 'false');
    } finally {
      harness.dom.window.close();
    }
  });

  test('closes the open filter dropdown on Escape and restores focus to its trigger', () => {
    const harness = createHarness();
    try {
      loadBundles(harness);
      const { document } = harness.dom.window;

      FILTER_DROPDOWNS.forEach(({ trigger, dropdown }) => {
        (document.querySelector(trigger) as unknown as { click: () => void }).click();
        assert.deepStrictEqual(visibleDropdowns(harness), [dropdown]);

        pressEscape(harness);

        assert.deepStrictEqual(visibleDropdowns(harness), [], dropdown + ' should close on Escape');
        assert.strictEqual(document.querySelector(trigger)?.getAttribute('aria-expanded'), 'false');
        assert.strictEqual(document.activeElement, document.querySelector(trigger), 'focus should return to ' + trigger);
      });
    } finally {
      harness.dom.window.close();
    }
  });

  test('ignores Escape when no filter dropdown is open', () => {
    const harness = createHarness();
    try {
      loadBundles(harness);
      const { document } = harness.dom.window;
      const searchBox = document.querySelector('#searchBox') as unknown as { focus: () => void };
      searchBox.focus();

      pressEscape(harness);

      assert.deepStrictEqual(visibleDropdowns(harness), []);
      assert.strictEqual(document.activeElement, document.querySelector('#searchBox'), 'focus should stay where it was');
    } finally {
      harness.dom.window.close();
    }
  });

  test('keeps Details and Repository actions functional and renders tab empty states', () => {
    const harness = createHarness();
    try {
      loadBundles(harness);
      const { document } = harness.dom.window;

      const sortToggle = document.querySelector('#sortToggleBtn') as unknown as { click: () => void };
      const sortSummary = document.querySelector('#sortSummary');
      assert.ok(sortSummary);
      assert.strictEqual(sortSummary?.parentElement?.id, 'sortToggleBtn');
      assert.strictEqual(sortSummary?.textContent, 'Relevance');
      (sortSummary as unknown as { click: () => void }).click();
      assert.strictEqual(document.querySelector('#sortPopover')?.getAttribute('style'), 'display: block;');
      sortToggle.click();
      assert.strictEqual(document.querySelector('#resultsCount')?.textContent, 'Showing all bundles');

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
      assert.strictEqual(document.querySelector('#resultsCount')?.textContent, '');
      assert.match(document.querySelector('#marketplace')?.textContent ?? '', /No installed bundles/);

      (document.querySelector('[data-tab="updates"]') as unknown as { click: () => void }).click();
      assert.match(document.querySelector('#marketplace')?.textContent ?? '', /All installed bundles are up to date/);
    } finally {
      harness.dom.window.close();
    }
  });

  test('hides the all-bundles status when the catalog is empty', () => {
    const harness = createHarness();
    try {
      const { document } = harness.dom.window;
      harness.dom.window.dispatchEvent(new harness.dom.window.MessageEvent('message', {
        data: {
          type: 'bundlesLoaded',
          bundles: [],
          filterOptions: { tags: [], sources: [], environments: [] },
          setupState: 'complete',
          sourcesCount: 1
        }
      }));

      assert.strictEqual(document.querySelector('#resultsCount')?.textContent, '');
    } finally {
      harness.dom.window.close();
    }
  });
});
