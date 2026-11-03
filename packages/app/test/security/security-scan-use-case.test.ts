import type {
  Clock,
  SecurityCancellation,
  SecurityDocument,
  SecurityFinding,
  SecurityInputCandidate,
  SecurityInputCollection,
  SecurityInputReadResult,
  SecurityInputRequest,
  SecurityResourceLimits,
  SecurityScanEngine,
  SecurityScanInput,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  runSecurityScan,
} from '../../src/security';

const clock: Clock = {
  now: () => 1_700_000_000_000,
  nowIso: () => '2023-11-14T22:13:20.000Z'
};
const cancellation: SecurityCancellation = {
  cancelled: false,
  throwIfCancelled: () => undefined
};
const limits: SecurityResourceLimits = {
  maxFiles: 10,
  maxFileBytes: 1000,
  maxTotalBytes: 5000,
  maxDepth: 4,
  maxFindings: 100,
  maxIgnoreBytes: 1000,
  maxIgnoreLines: 10,
  maxReportBytes: 10_000,
  timeoutMs: 1000,
  documentTimeoutMs: 1000
};

const request: SecurityInputRequest = {
  roots: ['/repo'],
  extensions: ['.md'],
  recursive: true,
  excludes: [],
  includeDocFiles: false,
  ignoreTrust: 'repository'
};

const candidate: SecurityInputCandidate = {
  id: '/repo/a.md',
  rootId: '/repo',
  absolutePath: '/repo/a.md',
  displayPath: 'a.md',
  depth: 1
};
const document: SecurityDocument = {
  id: candidate.id,
  rootId: candidate.rootId,
  displayPath: candidate.displayPath,
  content: '# content',
  metadata: { bytes: 9, source: 'filesystem' }
};
const finding: SecurityFinding = {
  ruleId: 'SEC-001',
  title: 'Secret',
  severity: 'CRITICAL',
  confidence: 'HIGH',
  category: 'secrets',
  file: 'a.md',
  line: 1,
  vulnerableContent: '[REDACTED]',
  risk: 'risk',
  recommendedFix: 'fix',
  fingerprint: 'instance',
  canonicalFingerprint: 'canonical'
};

class StubInput implements SecurityScanInput {
  public constructor(private readonly readResult: SecurityInputReadResult = { document }) {}
  public async collect(_request: SecurityInputRequest, _limits: SecurityResourceLimits, _cancellation: SecurityCancellation): Promise<SecurityInputCollection> {
    return { candidates: [candidate], ignoredFiles: [], skippedFiles: [], errors: [], suppressions: [], warnings: [] };
  }

  public async read(_candidate: SecurityInputCandidate, _limits: SecurityResourceLimits, _cancellation: SecurityCancellation): Promise<SecurityInputReadResult> {
    return this.readResult;
  }
}

class StubEngine implements SecurityScanEngine {
  public readonly descriptor = {
    id: 'stub', version: '1', rulePackId: 'test', rulePackVersion: '1', rulePackDigest: 'sha256:test'
  };

  public readonly capabilities = {
    contentTypes: ['text/markdown'] as const, locations: 'line' as const, supportsFileMode: false, supportsCancellation: true
  };

  public async scanDocument(
    _document: SecurityDocument,
    _options: { includeLlmControls: boolean; skipInfoControls: boolean; maxFindings: number },
    _cancellation: SecurityCancellation
  ): Promise<readonly SecurityFinding[]> {
    return [finding];
  }
}

describe('runSecurityScan', () => {
  it('assembles findings, coverage, policy, and engine metadata', async () => {
    const result = await runSecurityScan({ input: new StubInput(), engine: new StubEngine(), clock, cancellation, request, limits, failOn: 'HIGH' });
    expect(result.complete).toBe(true);
    expect(result.findings).toEqual([{ ...finding, rootId: document.rootId }]);
    expect(result.summary.active.total).toBe(1);
    expect(result.summary.policy).toEqual({ failOn: 'HIGH', passed: false, blocking: ['CRITICAL'] });
    expect(result.engine.id).toBe('stub');
  });

  it('attributes rootless engine findings to their scanned document, not every matching basename', async () => {
    const secondCandidate = { ...candidate, id: '/other/a.md', rootId: '/other', absolutePath: '/other/a.md' };
    const input: SecurityScanInput = {
      collect: async () => ({
        candidates: [candidate, secondCandidate], ignoredFiles: [], skippedFiles: [], errors: [], warnings: [],
        suppressions: [{ token: 'instance', sourcePath: '/repo/.markdown.ignore', scopeRoot: '/repo', line: 1 }]
      }),
      read: async (entry) => ({ document: { ...document, id: entry.id, rootId: entry.rootId } })
    };
    const result = await runSecurityScan({
      input, engine: new StubEngine(), clock, cancellation, request: { ...request, roots: ['/repo', '/other'] }, limits
    });
    expect(result.findings).toEqual([{ ...finding, rootId: '/other' }]);
    expect(result.summary.suppressed.total).toBe(1);
  });

  it('suppresses findings before policy evaluation', async () => {
    const suppressedInput = new StubInput();
    const input = {
      collect: async () => ({
        candidates: [candidate], ignoredFiles: [], skippedFiles: [], errors: [], warnings: [],
        suppressions: [{ token: 'instance', sourcePath: '/repo/.markdown.ignore', scopeRoot: '/repo', line: 1 }]
      }),
      read: suppressedInput.read.bind(suppressedInput)
    } as SecurityScanInput;
    const result = await runSecurityScan({ input, engine: new StubEngine(), clock, cancellation, request, limits, failOn: 'HIGH' });
    expect(result.findings).toEqual([]);
    expect(result.summary.suppressed.total).toBe(1);
    expect(result.summary.policy.passed).toBe(true);
  });

  it('marks unreadable inputs incomplete and preserves the operational error', async () => {
    const result = await runSecurityScan({
      input: new StubInput({ error: { code: 'SECURITY.INPUT_UNREADABLE', message: 'Cannot read' } }),
      engine: new StubEngine(), clock, cancellation, request, limits, failOn: 'none'
    });
    expect(result.complete).toBe(false);
    expect(result.coverage.errors).toEqual([{ path: 'a.md', code: 'SECURITY.INPUT_UNREADABLE', message: 'Cannot read' }]);
  });

  it('returns incomplete coverage when the whole-scan deadline expires during collection', async () => {
    vi.useFakeTimers();
    try {
      const input: SecurityScanInput = {
        collect: () => new Promise(() => undefined),
        read: new StubInput().read.bind(new StubInput())
      };
      const resultPromise = runSecurityScan({ input, engine: new StubEngine(), clock, cancellation, request, limits });
      await vi.advanceTimersByTimeAsync(limits.timeoutMs);
      const result = await resultPromise;
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'SECURITY.LIMIT_EXCEEDED' }));
      expect(result.summary.policy.passed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces one aggregate deadline across successive document scans', async () => {
    let now = 1_700_000_000_000;
    const entries = ['a.md', 'b.md', 'c.md'].map((name) => ({ ...candidate, id: `/repo/${name}`, absolutePath: `/repo/${name}`, displayPath: name }));
    const input: SecurityScanInput = {
      collect: async () => ({ candidates: entries, ignoredFiles: [], skippedFiles: [], errors: [], suppressions: [], warnings: [] }),
      read: async (entry) => ({ document: { ...document, id: entry.id, displayPath: entry.displayPath } })
    };
    const evaluated: string[] = [];
    const engine: SecurityScanEngine = {
      ...new StubEngine(),
      scanDocument: async (entry) => {
        evaluated.push(entry.displayPath);
        now += 600;
        return [];
      }
    };
    const result = await runSecurityScan({
      input, engine, cancellation, request, limits,
      clock: { now: () => now, nowIso: () => new Date(now).toISOString() }
    });
    expect(evaluated).toEqual(['a.md', 'b.md']);
    expect(result.complete).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'SECURITY.LIMIT_EXCEEDED' }));
  });

  it('records engine failures as incomplete coverage rather than losing the report', async () => {
    const engine: SecurityScanEngine = {
      ...new StubEngine(),
      scanDocument: async () => {
        throw new Error('SECURITY.LIMIT_EXCEEDED: document evaluation timed out');
      }
    };
    const result = await runSecurityScan({ input: new StubInput(), engine, clock, cancellation, request, limits });
    expect(result.complete).toBe(false);
    expect(result.coverage.scanned).toEqual([]);
    expect(result.errors).toContainEqual(expect.objectContaining({ path: 'a.md', code: 'SECURITY.LIMIT_EXCEEDED' }));
  });

  it('allows exactly the configured finding count without declaring truncation', async () => {
    const result = await runSecurityScan({
      input: new StubInput(), engine: new StubEngine(), clock, cancellation, request,
      limits: { ...limits, maxFindings: 1 }, failOn: 'none'
    });
    expect(result.complete).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  it('caps findings across documents and records actual truncation', async () => {
    const input: SecurityScanInput = {
      collect: async () => ({
        candidates: [candidate, { ...candidate, id: '/repo/b.md', displayPath: 'b.md' }],
        ignoredFiles: [], skippedFiles: [], errors: [], suppressions: [], warnings: []
      }),
      read: async (entry) => ({ document: { ...document, id: entry.id, displayPath: entry.displayPath } })
    };
    const evaluated: string[] = [];
    const engine: SecurityScanEngine = {
      ...new StubEngine(),
      scanDocument: async (entry) => {
        evaluated.push(entry.displayPath);
        return [{ ...finding, file: entry.displayPath }, { ...finding, file: entry.displayPath, ruleId: 'SEC-002' }];
      }
    };
    const result = await runSecurityScan({
      input, engine, clock, cancellation, request,
      limits: { ...limits, maxFindings: 3 }, failOn: 'none'
    });
    expect(result.complete).toBe(false);
    expect(result.findings).toHaveLength(3);
    expect(evaluated).toEqual(['a.md', 'b.md']);
    expect(result.findings.filter((item) => item.file === 'b.md')).toHaveLength(1);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'SECURITY.LIMIT_EXCEEDED' }));
  });

  it('releases engine resources even when cancellation aborts the scan', async () => {
    let disposed = false;
    const engine: SecurityScanEngine = {
      ...new StubEngine(),
      scanDocument: new StubEngine().scanDocument.bind(new StubEngine()),
      dispose: () => {
        disposed = true;
      }
    };
    await expect(runSecurityScan({
      input: new StubInput(), engine, clock, request, limits,
      cancellation: { cancelled: true, throwIfCancelled: () => {
        throw new Error('cancelled');
      } }
    })).rejects.toThrow('cancelled');
    expect(disposed).toBe(true);
  });
});
