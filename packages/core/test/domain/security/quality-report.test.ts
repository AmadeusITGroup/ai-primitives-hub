import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  aggregateQualityBlocks,
  buildQualityReport,
  rateFindings,
  type SecurityFinding,
} from '../../../src/domain/security';

const finding = (overrides: Partial<SecurityFinding> = {}): SecurityFinding => ({
  ruleId: 'HKS-001',
  title: 'Remote Shell Pipe',
  severity: 'HIGH',
  confidence: 'HIGH',
  category: 'hooks',
  file: 'skills/a/SKILL.md',
  line: 3,
  vulnerableContent: 'curl x | sh',
  risk: 'Runs remote code',
  recommendedFix: 'Pin and verify the download',
  fingerprint: 'f',
  canonicalFingerprint: 'c',
  ...overrides
});

const generatedAt = '2026-10-29T10:00:00.000Z';

const build = (findings: SecurityFinding[], failOn: 'none' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' = 'CRITICAL') => buildQualityReport({
  findings,
  bundles: [
    { id: 'a', version: '1.0.0', files: ['skills/a/SKILL.md', 'prompts/a.prompt.md'] },
    { id: 'b', version: '2.0.0', files: ['skills/b/SKILL.md'] },
    { id: 'clean', version: '1.0.0', files: ['skills/clean/SKILL.md'] }
  ],
  mode: 'collections',
  failOn,
  generatedAt,
  scanner: { name: 'ai-primitives-hub-security', version: '1.0.0' },
  source: { repository: 'o/r', tag: '', commit: 'abc' }
});

describe('security quality report', () => {
  describe('rateFindings', () => {
    it('summarises score, risk, penalty, counts and the costliest findings with their fix', () => {
      const block = rateFindings([
        finding({ ruleId: 'A-1', severity: 'LOW', line: 1 }),
        finding({ ruleId: 'B-1', severity: 'CRITICAL', line: 2 })
      ]);
      expect(block.penalty).toBe(43);
      expect(block.score).toBe(34);
      expect(block.risk).toBe('critical');
      expect(block.counts).toEqual({ CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 1, INFO: 0 });
      expect(block.findings.map((item) => [item.ruleId, item.points])).toEqual([['B-1', 40], ['A-1', 3]]);
      expect(block.findings[0]).toMatchObject({ file: 'skills/a/SKILL.md', line: 2, title: 'Remote Shell Pipe', fix: 'Pin and verify the download' });
    });

    it('caps the listed findings but counts all of them', () => {
      const many = Array.from({ length: 30 }, (_, index) => finding({ ruleId: `R-${String(index)}`, line: index + 1 }));
      const block = rateFindings(many, { maxFindings: 5 });
      expect(block.findings).toHaveLength(5);
      expect(block.counts.HIGH).toBe(30);
    });

    it('never copies the matched text into the report', () => {
      const block = rateFindings([finding({ vulnerableContent: 'SECRET-VALUE', ruleId: 'SEC-001', severity: 'CRITICAL' })]);
      expect(JSON.stringify(block)).not.toContain('SECRET-VALUE');
    });

    it('rates a clean block 100/low and keeps zero-point findings out of the list', () => {
      expect(rateFindings([])).toMatchObject({ score: 100, risk: 'low', penalty: 0, findings: [] });
      expect(rateFindings([finding({ severity: 'INFO' })]).findings).toEqual([]);
    });
  });

  describe('aggregateQualityBlocks', () => {
    it('averages the scores with halves rounded up and bands that average', () => {
      const blocks = [91, 100].map((score) => ({ score, risk: 'low' as const, penalty: 0, counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 }, findings: [] }));
      const result = aggregateQualityBlocks(blocks, 20);
      expect(result.score).toBe(96);
      expect(result.risk).toBe('low');
    });

    it('ignores unscored blocks and gives null when none is scored', () => {
      expect(aggregateQualityBlocks([], 20)).toMatchObject({ score: null, risk: 'unknown' });
    });
  });

  describe('buildQualityReport', () => {
    const findings = [
      finding({ file: 'skills/a/SKILL.md', ruleId: 'HKS-001', severity: 'CRITICAL' }),
      finding({ file: 'skills/b/SKILL.md', ruleId: 'INJ-001', severity: 'MEDIUM' }),
      finding({ file: 'README.md', ruleId: 'MD-002', severity: 'HIGH' })
    ];

    it('rates each bundle only on its own files', () => {
      const report = build(findings);
      const byId = Object.fromEntries(report.bundles.map((bundle) => [bundle.id, bundle]));
      expect(byId.a).toMatchObject({ score: 37, risk: 'critical', version: '1.0.0' });
      expect(byId.b).toMatchObject({ score: 82, risk: 'medium' });
      expect(byId.clean).toMatchObject({ score: 100, risk: 'low' });
      expect(report.bundles.map((bundle) => bundle.id)).toEqual(['a', 'b', 'clean']);
    });

    it('rates the source as the average of its bundles', () => {
      const report = build(findings);
      expect(report.repo.basis).toBe('bundles-average');
      expect(report.repo.score).toBe(73);
      expect(report.repo.risk).toBe('medium');
      expect(report.source.mode).toBe('collections');
    });

    it('fails the gate when any bundle is below the limit and passes otherwise', () => {
      expect(build(findings).gate).toEqual({ failOn: 'CRITICAL', passed: false });
      expect(build(findings.slice(1)).gate).toEqual({ failOn: 'CRITICAL', passed: true });
      expect(build(findings, 'none').gate).toEqual({ failOn: 'NONE', passed: true });
    });

    it('normalises separators when matching findings to bundle files', () => {
      const report = buildQualityReport({
        findings: [finding({ file: 'skills\\a\\SKILL.md' })],
        bundles: [{ id: 'a', version: '1', files: ['./skills/a/SKILL.md'] }],
        mode: 'collections', failOn: 'HIGH', generatedAt, scanner: { name: 'x' }, source: { repository: 'o/r', tag: '', commit: '' }
      });
      expect(report.bundles[0].counts.HIGH).toBe(1);
    });

    it('falls back to the whole repository when there are no bundles', () => {
      const report = buildQualityReport({
        findings, bundles: [], mode: 'repository', failOn: 'CRITICAL', generatedAt,
        scanner: { name: 'x' }, source: { repository: 'o/r', tag: '', commit: '' }
      });
      expect(report.bundles).toEqual([]);
      expect(report.repo.basis).toBe('repository');
      expect(report.repo.counts.CRITICAL).toBe(1);
      expect(report.gate.passed).toBe(false);
    });

    it('is stable for identical input', () => {
      expect(JSON.stringify(build(findings))).toBe(JSON.stringify(build(findings)));
    });
  });
});
