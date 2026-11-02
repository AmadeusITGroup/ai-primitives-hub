import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  runQualityRating,
} from '../../src/security';

const clock: Clock = { now: () => 1_700_000_000_000, nowIso: () => '2023-11-14T22:13:20.000Z' };
const cancellation: SecurityCancellation = { cancelled: false, throwIfCancelled: () => undefined };
const limits: SecurityResourceLimits = {
  maxFiles: 50, maxFileBytes: 1000, maxTotalBytes: 50_000, maxDepth: 8, maxFindings: 100,
  maxIgnoreBytes: 1000, maxIgnoreLines: 10, maxReportBytes: 10_000, timeoutMs: 1000, documentTimeoutMs: 1000
};

const finding = (file: string, ruleId: string, severity: SecurityFinding['severity']): SecurityFinding => ({
  ruleId, title: `${ruleId} title`, severity, confidence: 'HIGH', category: 'test', file, line: 1,
  vulnerableContent: '[REDACTED]', risk: 'risk', recommendedFix: `fix ${ruleId}`, fingerprint: `${ruleId}${file}`, canonicalFingerprint: ruleId
});

class FilesInput implements SecurityScanInput {
  public requests: SecurityInputRequest[] = [];
  public constructor(private readonly root: string, private readonly files: readonly string[], private readonly absolute = false) {}

  public collect(request: SecurityInputRequest, _limits: SecurityResourceLimits, _cancellation: SecurityCancellation): Promise<SecurityInputCollection> {
    this.requests.push(request);
    return Promise.resolve({
      candidates: this.files.map((file): SecurityInputCandidate => ({
        id: file, rootId: this.root, absolutePath: path.join(this.root, file),
        displayPath: this.absolute ? path.join(this.root, file) : file, depth: 1
      })),
      ignoredFiles: [], skippedFiles: [], errors: [], suppressions: [], warnings: []
    });
  }

  public read(candidate: SecurityInputCandidate, _limits: SecurityResourceLimits, _cancellation: SecurityCancellation): Promise<SecurityInputReadResult> {
    const document: SecurityDocument = {
      id: candidate.id, rootId: candidate.rootId, displayPath: candidate.displayPath, content: '# x',
      metadata: { bytes: 3, source: 'filesystem' }
    };
    return Promise.resolve({ document });
  }
}

class ByFileEngine implements SecurityScanEngine {
  public readonly descriptor = { id: 'stub', version: '9', rulePackId: 'p', rulePackVersion: '1', rulePackDigest: 'sha256:abcdefabcdef' };
  public readonly capabilities = { contentTypes: ['text/markdown'] as const, locations: 'line' as const, supportsFileMode: false, supportsCancellation: true };
  public constructor(private readonly byFile: Readonly<Record<string, SecurityFinding[]>>) {}
  public scanDocument(document: SecurityDocument): Promise<readonly SecurityFinding[]> {
    const found = this.byFile[path.basename(path.dirname(document.displayPath))] ?? this.byFile[document.displayPath] ?? [];
    // Report the file the way the input named it, absolute or not.
    return Promise.resolve(found.map((item) => ({ ...item, file: document.displayPath })));
  }
}

const write = (root: string, relative: string, text = 'x'): void => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
};

describe('runQualityRating', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-rating-'));
    write(root, 'collections/a.collection.yml', 'id: a\nname: A\nversion: 1.0.0\nitems:\n  - path: skills/a/SKILL.md\n    kind: skill\n');
    write(root, 'collections/b.collection.yml', 'id: b\nname: B\nversion: 2.0.0\nitems:\n  - path: skills/b/SKILL.md\n    kind: skill\n');
    write(root, 'skills/a/SKILL.md');
    write(root, 'skills/b/SKILL.md');
    write(root, 'README.md');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rate = async (options: { failOn?: 'none' | 'CRITICAL' | 'HIGH'; absolute?: boolean; input?: FilesInput } = {}) => {
    const input = options.input ?? new FilesInput(root, ['skills/a/SKILL.md', 'skills/b/SKILL.md', 'README.md'], options.absolute);
    const engine = new ByFileEngine({
      a: [finding('skills/a/SKILL.md', 'HKS-001', 'CRITICAL')],
      b: [finding('skills/b/SKILL.md', 'INJ-001', 'MEDIUM')],
      'README.md': [finding('README.md', 'MD-002', 'HIGH')]
    });
    const result = await runQualityRating({
      input, engine, clock, cancellation, limits,
      request: { root, repository: 'o/r', failOn: options.failOn ?? 'CRITICAL', commit: 'abc' }
    });
    return { result, input };
  };

  it('rates each collection on its own files and the source as their average', async () => {
    const { result } = await rate();
    const { report } = result;
    expect(report.bundles.map((bundle) => [bundle.id, bundle.score, bundle.risk])).toEqual([['a', 37, 'critical'], ['b', 82, 'medium']]);
    expect(report.repo).toMatchObject({ basis: 'bundles-average', score: 60, risk: 'high' });
    expect(report.source).toEqual({ repository: 'o/r', tag: '', commit: 'abc', mode: 'collections' });
    expect(report.generatedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(report.scanner).toEqual({ name: 'ai-primitives-hub-security' });
  });

  it('fails the gate when a bundle is below the limit and passes when the gate is off', async () => {
    expect((await rate()).result.report.gate).toEqual({ failOn: 'CRITICAL', passed: false });
    expect((await rate({ failOn: 'none' })).result.report.gate).toEqual({ failOn: 'NONE', passed: true });
  });

  it('matches findings reported with absolute paths', async () => {
    const { result } = await rate({ absolute: true });
    expect(result.report.bundles[0].counts.CRITICAL).toBe(1);
  });

  it('scans documentation too and ignores repository suppressions by default', async () => {
    const { input } = await rate();
    expect(input.requests[0]).toMatchObject({ roots: [root], includeDocFiles: true, ignoreTrust: 'none', recursive: true });
  });

  it('reports an incomplete scan so the caller can refuse a rating', async () => {
    const input = new FilesInput(root, ['skills/a/SKILL.md']);
    const unreadable: SecurityScanInput = {
      collect: input.collect.bind(input),
      read: () => Promise.resolve({ error: { code: 'SECURITY.INPUT_UNREADABLE', message: 'no' } })
    };
    const { result } = await rate({ input: unreadable as FilesInput });
    expect(result.scan.complete).toBe(false);
  });

  it('carries discovery warnings and falls back to the repository without collections', async () => {
    fs.rmSync(path.join(root, 'collections'), { recursive: true });
    fs.rmSync(path.join(root, 'skills'), { recursive: true });
    const { result } = await rate({ input: new FilesInput(root, ['README.md']) });
    expect(result.report.repo.basis).toBe('repository');
    expect(result.report.source.mode).toBe('repository');
    expect(result.report.bundles).toEqual([]);
  });
});
