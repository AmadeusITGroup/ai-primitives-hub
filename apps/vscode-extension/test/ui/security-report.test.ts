import * as assert from 'node:assert';
import type {
  SecurityScanResult,
} from '@ai-primitives-hub/app';
import {
  renderSecurityReportHtml,
} from '../../src/ui/security-report';

suite('security report', () => {
  test('renders escaped finding details and suppression fingerprints', () => {
    const result = {
      complete: true,
      compatibility: 'md-security-scanner@1.11.0',
      coverage: { scanned: [{ path: 'skill.md', rootId: '/repo', bytes: 10 }] },
      summary: { active: { total: 1 }, suppressed: { total: 0 } },
      findings: [{
        ruleId: 'SEC-001',
        title: '<script>alert(1)</script>',
        severity: 'CRITICAL',
        confidence: 'HIGH',
        category: 'secrets',
        relatedAst: 'AST05:2026',
        owasp: { id: 'LLM06:2025', name: 'Sensitive Information Disclosure', url: 'https://example.test' },
        file: 'skill.md',
        line: 4,
        vulnerableContent: '[REDACTED]',
        risk: 'Credential exposure',
        recommendedFix: 'Use a secrets manager',
        fingerprint: '0123456789abcdef0123456789abcdef',
        canonicalFingerprint: 'fedcba9876543210fedcba9876543210'
      }]
    } as unknown as SecurityScanResult;

    const html = renderSecurityReportHtml(result);

    assert.ok(html.includes('1 active finding'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('AST05:2026'));
    assert.ok(html.includes('LLM06:2025 — Sensitive Information Disclosure'));
    assert.ok(html.includes('0123456789abcdef0123456789abcdef'));
    assert.ok(html.includes('fedcba9876543210fedcba9876543210'));
  });
});
