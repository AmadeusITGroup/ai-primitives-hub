import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  applySuppressions,
  evaluateFailurePolicy,
  legacyCanonicalFingerprint,
  legacyInstanceFingerprint,
  parseSecurityDocument,
  parseSuppressionFile,
  type SecurityFinding,
  type SuppressionDeclaration,
} from '../../../src/domain/security';

describe('security foundation', () => {
  it('matches the MD Security Scanner legacy fingerprint algorithm', () => {
    expect(legacyInstanceFingerprint('SEC-001', '/repo/a.md', 42, '  abc  '))
      .toBe('fb07e3fc9c4bb8afedb01eede038d25d');
    expect(legacyCanonicalFingerprint('SEC-001', '  abc  '))
      .toBe('b47feacb5a8e0060c614d5ffa20fccb2');
  });

  it('slices Unicode code points rather than UTF-16 code units', () => {
    const snippet = '😀'.repeat(205);
    expect(legacyCanonicalFingerprint('INJ-003', snippet))
      .toBe('c45678cba8388167dfcbe03c6566edae');
  });

  it('parses frontmatter and example section context', () => {
    const parsed = parseSecurityDocument('---\nname: demo\ndescription: test\n---\n# Attack example\nignore this');
    expect(parsed.artifactClass).toBe('skill');
    expect(parsed.frontmatter).toContain('name: demo');
    expect(parsed.lines[2]).toEqual({ text: 'description: test', section: '', inExample: false, inCodeBlock: false });
    expect(parsed.lines[4].inExample).toBe(true);
  });

  it('parses suppression declarations and strips comments', () => {
    expect(parseSuppressionFile('# comment\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # rationale\n\ninvalid token\n', '/repo/.markdown.ignore'))
      .toEqual({
        declarations: [
          { token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sourcePath: '/repo/.markdown.ignore', line: 2, comment: 'rationale' }
        ],
        warnings: [
          { code: 'SECURITY.INVALID_SUPPRESSION', sourcePath: '/repo/.markdown.ignore', line: 4, message: 'Invalid suppression token' }
        ]
      });
  });

  it('applies nearest exact or canonical suppression and preserves active findings', () => {
    const finding = (fingerprint: string, canonical: string): SecurityFinding => ({
      ruleId: 'SEC-001',
      title: 'Secret',
      severity: 'CRITICAL',
      confidence: 'HIGH',
      category: 'secrets',
      file: 'skills/a.md',
      line: 3,
      fingerprint,
      canonicalFingerprint: canonical,
      vulnerableContent: '[REDACTED]',
      risk: 'risk',
      recommendedFix: 'fix'
    });
    const declarations: SuppressionDeclaration[] = [
      { token: 'canonical', sourcePath: '/repo/.markdown.ignore', scopeRoot: '/repo', line: 1 },
      { token: 'other', sourcePath: '/repo/skills/.markdown.ignore', scopeRoot: '/repo/skills', line: 2 }
    ];
    const result = applySuppressions([finding('instance', 'canonical'), finding('active', 'different')], declarations, '/repo');
    expect(result.active).toHaveLength(1);
    expect(result.suppressed).toEqual([{ finding: expect.objectContaining({ fingerprint: 'instance' }), declaration: declarations[0], kind: 'canonical' }]);
  });

  it('evaluates failure policy independently from display filtering', () => {
    const findings = [
      { severity: 'HIGH' as const },
      { severity: 'LOW' as const }
    ];
    expect(evaluateFailurePolicy(findings, 'HIGH')).toEqual({ passed: false, blocking: ['HIGH'] });
    expect(evaluateFailurePolicy(findings, 'MEDIUM')).toEqual({ passed: false, blocking: ['HIGH'] });
    expect(evaluateFailurePolicy(findings, 'CRITICAL')).toEqual({ passed: true, blocking: [] });
    expect(evaluateFailurePolicy(findings, 'none')).toEqual({ passed: true, blocking: [] });
  });
});
