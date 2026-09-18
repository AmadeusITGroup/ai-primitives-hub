import type {
  SecurityCancellation,
  SecurityDocument,
} from '@ai-primitives-hub/core';
import {
  RuleBasedSecurityScanEngine,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  IsolatedSecurityScanEngine,
} from '../../src/security';

const cancellation: SecurityCancellation = { cancelled: false, throwIfCancelled: () => undefined };
const document: SecurityDocument = {
  id: 'demo.md', rootId: 'root', displayPath: 'demo.md',
  content: 'token = sk-proj-abcdefghijklmnopqrstuvwxyz',
  metadata: { bytes: 43, source: 'filesystem' }
};

describe('IsolatedSecurityScanEngine', () => {
  it('runs the built-in engine behind an interruptible worker boundary', async () => {
    const base = new RuleBasedSecurityScanEngine();
    const engine = new IsolatedSecurityScanEngine(base.descriptor, base.capabilities, 2000, base);
    const result = await engine.scanDocument(document, {
      includeLlmControls: false, skipInfoControls: false, maxFindings: 10
    }, cancellation);
    expect(result[0]).toMatchObject({ ruleId: 'SEC-001', vulnerableContent: '[REDACTED]' });
  });
});
