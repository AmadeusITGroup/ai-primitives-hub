import * as assert from 'node:assert';
import {
  validateRepositoryInstallPolicy,
} from '../../src/services/repository-install-policy';
import type {
  Resource,
} from '../../src/types/target';

suite('RepositoryInstallPolicy', () => {
  test('rejects secret-like prompt content for committed repository installs with redacted diagnostics', () => {
    const result = validateRepositoryInstallPolicy({
      commitMode: 'commit',
      resources: [createResource('prompt', 'review', 'API_TOKEN=super-secret-value')]
    });

    assert.strictEqual(result.allowed, false);
    assert.deepStrictEqual(result.diagnostics, [
      {
        severity: 'error',
        code: 'secret-like-content',
        resourceId: 'review',
        message: 'Repository install rejected because prompt review contains [REDACTED].',
        remediation: 'Install to user scope or remove the secret-like content before committing.'
      }
    ]);
  });

  test('rejects secret-like instruction, agent, and skill content for committed repository installs', () => {
    const result = validateRepositoryInstallPolicy({
      commitMode: 'commit',
      resources: [
        createResource('instruction', 'coding', 'password = "abc123"'),
        createResource('agent', 'planner', 'client_secret: abc123'),
        createResource('skill', 'analyzer', '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----')
      ]
    });

    assert.strictEqual(result.allowed, false);
    const diagnostics = result.diagnostics as RepositoryInstallPolicyDiagnostic[];

    assert.deepStrictEqual(diagnostics.map((diagnostic) => diagnostic.resourceId), [
      'coding',
      'planner',
      'analyzer'
    ]);
    for (const diagnostic of diagnostics) {
      assert.ok(!diagnostic.message.includes('abc123'));
      assert.ok(diagnostic.message.includes('[REDACTED]'));
    }
  });

  test('routes local-only resource references away from committed repository installs', () => {
    const result = validateRepositoryInstallPolicy({
      commitMode: 'commit',
      resources: [createResource('prompt', 'local-helper', 'Use /Users/example/.ssh/config for this local workflow.')]
    });

    assert.strictEqual(result.allowed, false);
    assert.deepStrictEqual(result.routeDecision, {
      action: 'route-local-only',
      commitMode: 'local-only'
    });
    assert.deepStrictEqual(result.diagnostics, [
      {
        severity: 'warning',
        code: 'local-only-reference',
        resourceId: 'local-helper',
        message: 'Repository install should not commit local-only reference [REDACTED].',
        remediation: 'Use local-only repository mode or user scope for machine-specific resources.'
      }
    ]);
  });
});

function createResource(kind: Resource['kind'], id: string, content: string): Resource {
  return {
    kind,
    id,
    sourcePath: `${kind}s/${id}.md`,
    content
  };
}

interface RepositoryInstallPolicyDiagnostic {
  resourceId: string;
  message: string;
}
