/**
 * First-run default-hub reporting: an account with no access to a hub we
 * ship by default is expected and must never look like a fault.
 */

import * as assert from 'node:assert';
import type {
  HubAvailability,
} from '@ai-primitives-hub/app';
import {
  getRecommendedHub,
} from '@ai-primitives-hub/infra';
import {
  describeHubAvailability,
  isExpectedNoAccess,
  summarizeFirstRunHubs,
} from '../../src/utils/first-run-hub-report';
import type {
  FirstRunHub,
} from '../../src/utils/first-run-hub-report';

const CREDENTIAL = 'origin=vscode-session(octocat) token=***<len=40,tail=9c1e>';

function defaultHub(): FirstRunHub {
  const recommended = getRecommendedHub();
  assert.ok(recommended, 'a recommended default hub must be configured');
  return { name: recommended.name, reference: recommended.reference };
}

function customHub(): FirstRunHub {
  return { name: 'Someone Else', reference: { type: 'github', location: 'someone/private-hub', ref: 'main' } };
}

function unavailable(overrides: Partial<HubAvailability> = {}): HubAvailability {
  return { available: false, reason: 'no-access', credential: CREDENTIAL, detail: 'a verdict', ...overrides };
}

suite('first-run hub reporting', () => {
  suite('a default hub the account cannot see', () => {
    test('is reported at info, stating it is not an error', () => {
      const report = describeHubAvailability(defaultHub(), unavailable());

      assert.strictEqual(report.level, 'info');
      assert.strictEqual(report.expected, true);
      assert.ok(report.lines.join('\n').includes('not an error'));
    });

    test('names the credential that was used', () => {
      const report = describeHubAvailability(defaultHub(), unavailable());
      const text = report.lines.join('\n');

      assert.ok(text.includes('origin='), `expected an origin in:\n${text}`);
      assert.ok(text.includes('Hub not available to this account'));
    });

    test('produces an information notification, not a warning, when it is the only hub', () => {
      const hub = defaultHub();
      const summary = summarizeFirstRunHubs([{ hub, availability: unavailable() }]);

      assert.strictEqual(summary.notification, 'information');
      assert.ok(summary.message?.includes('import a custom hub'));
    });
  });

  suite('a real credential failure', () => {
    test('is reported at warn with the remediation commands', () => {
      const report = describeHubAvailability(defaultHub(), unavailable({ reason: 'auth-rejected' }));
      const text = report.lines.join('\n');

      assert.strictEqual(report.level, 'warn');
      assert.strictEqual(report.expected, false);
      assert.ok(text.includes('Hub unavailable'));
      assert.ok(text.includes('Diagnose GitHub Authentication'));
      assert.ok(text.includes('Force GitHub Authentication'));
      assert.ok(text.includes(CREDENTIAL));
    });

    test('produces a warning notification', () => {
      const summary = summarizeFirstRunHubs([
        { hub: defaultHub(), availability: unavailable({ reason: 'auth-rejected' }) }
      ]);

      assert.strictEqual(summary.notification, 'warning');
    });
  });

  test('a non-default hub the account cannot see is still a warning', () => {
    const report = describeHubAvailability(customHub(), unavailable());

    assert.strictEqual(report.level, 'warn');
    assert.strictEqual(report.expected, false);
    assert.strictEqual(isExpectedNoAccess(customHub(), unavailable()), false);
  });

  test('a reachable hub is reported as verified', () => {
    const report = describeHubAvailability(defaultHub(), { available: true });

    assert.strictEqual(report.level, 'info');
    assert.ok(report.lines[0].includes('Hub verified'));
  });

  test('no notification at all while at least one hub is reachable', () => {
    const summary = summarizeFirstRunHubs([
      { hub: defaultHub(), availability: unavailable() },
      { hub: customHub(), availability: { available: true } }
    ]);

    assert.strictEqual(summary.notification, 'none');
    assert.strictEqual(summary.message, undefined);
  });
});
