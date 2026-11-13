import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  QualityFinding,
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
} from '../../src/quality';

const generatedAt = '2023-11-14T22:13:20.000Z';

const finding = (file: string, ruleId: string, severity: QualityFinding['severity']): QualityFinding => ({
  ruleId, title: `${ruleId} title`, severity, confidence: 'HIGH', file, line: 1
});

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

  const findings = (absolute = false): QualityFinding[] => [
    finding('skills/a/SKILL.md', 'HKS-001', 'CRITICAL'),
    finding('skills/b/SKILL.md', 'INJ-001', 'MEDIUM'),
    finding('README.md', 'MD-002', 'HIGH')
  ].map((item) => (absolute ? { ...item, file: path.join(root, item.file) } : item));

  const rate = (options: { failOn?: 'none' | 'CRITICAL' | 'HIGH'; absolute?: boolean } = {}) => runQualityRating({
    findings: findings(options.absolute),
    generatedAt,
    request: { root, repository: 'o/r', failOn: options.failOn ?? 'CRITICAL', commit: 'abc', scannerName: 'test-scanner' }
  });

  it('rates each collection on its own files and the source as their average', () => {
    const { report } = rate();
    expect(report.bundles.map((bundle) => [bundle.id, bundle.score, bundle.risk])).toEqual([['a', 37, 'critical'], ['b', 82, 'medium']]);
    expect(report.repo).toMatchObject({ basis: 'bundles-average', score: 60, risk: 'high' });
    expect(report.source).toEqual({ repository: 'o/r', tag: '', commit: 'abc', mode: 'collections' });
    expect(report.generatedAt).toBe(generatedAt);
    expect(report.scanner).toEqual({ name: 'test-scanner' });
  });

  it('fills in a recommended fix for the rule family when the scanner gives none', () => {
    const [first] = rate().report.bundles[0].findings;
    expect(first.fix).not.toBe('');
  });

  it('fails the gate when a bundle is below the limit and passes when the gate is off', () => {
    expect(rate().report.gate).toEqual({ failOn: 'CRITICAL', passed: false });
    expect(rate({ failOn: 'none' }).report.gate).toEqual({ failOn: 'NONE', passed: true });
  });

  it('matches findings reported with absolute paths', () => {
    expect(rate({ absolute: true }).report.bundles[0].counts.CRITICAL).toBe(1);
  });

  it('falls back to the whole repository when there are no collections or skills', () => {
    fs.rmSync(path.join(root, 'collections'), { recursive: true });
    fs.rmSync(path.join(root, 'skills'), { recursive: true });
    const { report } = rate();
    expect(report.repo.basis).toBe('repository');
    expect(report.source.mode).toBe('repository');
    expect(report.bundles).toEqual([]);
  });
});

describe('runQualityRating findings outside the checkout', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-rating-outside-'));
    fs.writeFileSync(path.join(root, 'README.md'), 'x');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not count them against the whole repository', () => {
    const outside = [finding('../other/SKILL.md', 'HKS-001', 'CRITICAL'), finding(path.join(path.dirname(root), 'x', 'SKILL.md'), 'HKS-001', 'CRITICAL')];
    const { report } = runQualityRating({
      findings: [...outside, finding('..config/SKILL.md', 'MD-002', 'LOW')],
      generatedAt,
      request: { root, repository: 'o/r', failOn: 'CRITICAL', scannerName: 'test-scanner' }
    });
    expect(report.source.mode).toBe('repository');
    expect(report.repo.counts.CRITICAL).toBe(0);
    expect(report.repo.counts.LOW).toBe(1);
  });
});
