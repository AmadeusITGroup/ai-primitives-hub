import type {
  QualityBundle,
  QualityReport,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  renderQualityMarkdown,
  riskBadge,
  scoreBar,
} from '../../src/quality';

const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
const entry = (ruleId: string, points: number) => ({ ruleId, severity: 'HIGH' as const, points, file: 'skills/x/SKILL.md', line: 3, title: `Title | ${ruleId}`, fix: 'Do the fix' });

const bundle = (id: string, score: number, risk: QualityBundle['risk'], findings = [] as ReturnType<typeof entry>[]): QualityBundle => ({
  id, version: '1.0.0', score, risk, penalty: 100 - score, counts: { ...counts, HIGH: findings.length }, findings
});

const report = (bundles: QualityBundle[], passed: boolean): QualityReport => ({
  schemaVersion: 1,
  generatedAt: '2026-10-29T10:00:00.000Z',
  scanner: { name: 'test-scanner' },
  source: { repository: 'o/r', tag: '', commit: '', mode: 'collections' },
  repo: { basis: 'bundles-average', score: 60, risk: 'high', penalty: 120, counts, findings: [] },
  bundles,
  gate: { failOn: 'CRITICAL', passed }
});

describe('quality markdown', () => {
  it('draws a score bar and a risk badge', () => {
    expect(scoreBar(100)).toBe('█'.repeat(10));
    expect(scoreBar(0)).toBe('░'.repeat(10));
    expect(scoreBar(null)).toBe('—');
    expect(riskBadge('critical')).toBe('🔴 critical');
    expect(riskBadge('unknown')).toBe('⚪ unknown');
  });

  it('puts the failing bundle first with its findings and states the verdict', () => {
    const text = renderQualityMarkdown(report([bundle('good', 100, 'low'), bundle('bad', 20, 'critical', [entry('HKS-001', 20)])], false));
    expect(text).toContain('Quality scan: failed');
    expect(text).toContain('1 of 2 bundle(s) are below the limit');
    expect(text).toContain('Needs attention (1 below the gate limit)');
    expect(text.indexOf('`bad`')).toBeLessThan(text.indexOf('`good`'));
    expect(text).toContain('`HKS-001`');
    expect(text).toContain('Do the fix');
  });

  it('escapes table cells so a finding cannot break the table', () => {
    const text = renderQualityMarkdown(report([bundle('bad', 20, 'critical', [entry('R-1', 20)])], false));
    expect(text).toContain('Title \\| R-1');
  });

  it('says passed with every bundle in a collapsible table', () => {
    const text = renderQualityMarkdown(report([bundle('a', 100, 'low'), bundle('b', 95, 'low')], true));
    expect(text).toContain('Quality scan: passed');
    expect(text).toContain('All 2 bundles');
    expect(text).toContain('All 2 bundle(s) pass');
  });

  it('shows the whole-repository fallback with a note', () => {
    const fallback: QualityReport = { ...report([], false), repo: { basis: 'repository', score: 27, risk: 'critical', penalty: 53, counts, findings: [entry('X-1', 20)] } };
    const text = renderQualityMarkdown(fallback);
    expect(text).toContain('Whole repository 27/100');
    expect(text).toContain('scanned as one unit');
  });

  it('explains how the score works', () => {
    expect(renderQualityMarkdown(report([bundle('a', 100, 'low')], true))).toContain('exp(−penalty / 40)');
  });
});
