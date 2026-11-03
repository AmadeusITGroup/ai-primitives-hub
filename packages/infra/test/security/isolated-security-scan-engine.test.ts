import * as path from 'node:path';
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
    const engine = new IsolatedSecurityScanEngine(base.descriptor, base.capabilities, 2000,
      path.join(__dirname, '../../dist/security/isolated-security-scan-worker.js'));
    try {
      const result = await engine.scanDocument(document, {
        includeLlmControls: false, skipInfoControls: false, maxFindings: 10
      }, cancellation);
      expect(result[0]).toMatchObject({ ruleId: 'SEC-001', vulnerableContent: '[REDACTED]' });
    } finally {
      await engine.dispose();
    }
  });

  it('fails closed when the packaged worker is missing', async () => {
    const base = new RuleBasedSecurityScanEngine();
    const engine = new IsolatedSecurityScanEngine(base.descriptor, base.capabilities, 2000, path.join(__dirname, 'missing-worker.js'));
    await expect(engine.scanDocument(document, {
      includeLlmControls: false, skipInfoControls: false, maxFindings: 10
    }, cancellation)).rejects.toThrow('worker is not packaged');
  });

  it('reuses worker state across successive documents', async () => {
    const base = new RuleBasedSecurityScanEngine();
    const engine = new IsolatedSecurityScanEngine(base.descriptor, base.capabilities, 2000,
      path.join(__dirname, 'fixtures/stateful-worker.mjs'));
    const options = { includeLlmControls: false, skipInfoControls: false, maxFindings: 10 };
    try {
      const first = await engine.scanDocument(document, options, cancellation);
      const second = await engine.scanDocument(document, options, cancellation);
      expect(first[0].vulnerableContent).toBe('1');
      expect(second[0].vulnerableContent).toBe('2');
    } finally {
      await engine.dispose();
    }
  });

  it('restarts a timed-out worker and rejects scans after disposal', async () => {
    const base = new RuleBasedSecurityScanEngine();
    const engine = new IsolatedSecurityScanEngine(base.descriptor, base.capabilities, 250,
      path.join(__dirname, 'fixtures/stateful-worker.mjs'));
    const options = { includeLlmControls: false, skipInfoControls: false, maxFindings: 10 };
    try {
      await expect(engine.scanDocument({ ...document, id: 'wait' }, options, cancellation)).rejects.toThrow('timed out');
      const result = await engine.scanDocument(document, options, cancellation);
      expect(result[0].vulnerableContent).toBe('1');
    } finally {
      await engine.dispose();
    }
    await expect(engine.scanDocument(document, options, cancellation)).rejects.toThrow('disposed');
  });

  it('replaces workers that exit between requests instead of waiting for a misleading timeout', async () => {
    const base = new RuleBasedSecurityScanEngine();
    const engine = new IsolatedSecurityScanEngine(base.descriptor, base.capabilities, 250,
      path.join(__dirname, 'fixtures/stateful-worker.mjs'));
    const options = { includeLlmControls: false, skipInfoControls: false, maxFindings: 10 };
    try {
      await engine.scanDocument({ ...document, id: 'exit' }, options, cancellation);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await engine.scanDocument(document, options, cancellation);
      expect(result[0].vulnerableContent).toBe('1');
    } finally {
      await engine.dispose();
    }
  });

  it('surfaces idle worker errors without crashing the host, then allows a retry', async () => {
    const base = new RuleBasedSecurityScanEngine();
    const engine = new IsolatedSecurityScanEngine(base.descriptor, base.capabilities, 250,
      path.join(__dirname, 'fixtures/stateful-worker.mjs'));
    const options = { includeLlmControls: false, skipInfoControls: false, maxFindings: 10 };
    try {
      await engine.scanDocument({ ...document, id: 'error' }, options, cancellation);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(engine.scanDocument(document, options, cancellation)).rejects.toThrow('idle scan worker failed');
      expect((await engine.scanDocument(document, options, cancellation))[0].vulnerableContent).toBe('1');
    } finally {
      await engine.dispose();
    }
  });
});
