import * as assert from 'node:assert';
import {
  validateRepositoryInstallPolicy,
} from '../../src/services/repository-install-policy';
import type {
  Resource,
} from '../../src/types/target';

suite('Target repository safety for VS Code and Kiro', () => {
  const unsafeContent = 'API_KEY=super-secret-value\nDo not share this.';
  const safeContent = 'This is a safe prompt with no secrets.';

  const resourceKinds: { kind: NonNullable<Resource['kind']>; id: string }[] = [
    { kind: 'prompt', id: 'review' },
    { kind: 'instruction', id: 'coding' },
    { kind: 'agent', id: 'planner' },
    { kind: 'skill', id: 'analyzer' }
  ];

  suite('VS Code repository scope', () => {
    test('rejects all resource kinds with secret-like content', () => {
      for (const { kind, id } of resourceKinds) {
        const resource: Resource = { kind, id, sourcePath: `${id}.md`, content: unsafeContent };
        const result = validateRepositoryInstallPolicy({ commitMode: 'commit', resources: [resource] });

        assert.strictEqual(result.allowed, false, `${kind} ${id} should be rejected`);
        assert.ok(result.diagnostics.some((d) => d.code === 'secret-like-content'), `${kind} ${id} should have secret-like-content diagnostic`);
        assert.ok(result.diagnostics.some((d) => d.message.includes('[REDACTED]')), `${kind} ${id} should redact secrets`);
      }
    });

    test('allows all resource kinds with safe content', () => {
      for (const { kind, id } of resourceKinds) {
        const resource: Resource = { kind, id, sourcePath: `${id}.md`, content: safeContent };
        const result = validateRepositoryInstallPolicy({ commitMode: 'commit', resources: [resource] });

        assert.strictEqual(result.allowed, true, `${kind} ${id} should be allowed`);
        assert.strictEqual(result.diagnostics.length, 0, `${kind} ${id} should have no diagnostics`);
      }
    });
  });

  suite('Kiro repository scope', () => {
    const kiroResourceKinds = resourceKinds.filter((r) => r.kind === 'prompt' || r.kind === 'skill');

    test('rejects prompt and skill resources with secret-like content', () => {
      for (const { kind, id } of kiroResourceKinds) {
        const resource: Resource = { kind, id, sourcePath: `${id}.md`, content: unsafeContent };
        const result = validateRepositoryInstallPolicy({ commitMode: 'commit', resources: [resource] });

        assert.strictEqual(result.allowed, false, `${kind} ${id} should be rejected`);
        assert.ok(result.diagnostics.some((d) => d.code === 'secret-like-content'), `${kind} ${id} should have secret-like-content diagnostic`);
      }
    });

    test('allows prompt and skill resources with safe content', () => {
      for (const { kind, id } of kiroResourceKinds) {
        const resource: Resource = { kind, id, sourcePath: `${id}.md`, content: safeContent };
        const result = validateRepositoryInstallPolicy({ commitMode: 'commit', resources: [resource] });

        assert.strictEqual(result.allowed, true, `${kind} ${id} should be allowed`);
      }
    });
  });

  suite('shared safety policy across targets', () => {
    test('same unsafe content produces the same diagnostic regardless of target type', () => {
      const resource: Resource = { kind: 'prompt', id: 'review', sourcePath: 'review.md', content: unsafeContent };

      const result = validateRepositoryInstallPolicy({ commitMode: 'commit', resources: [resource] });

      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.diagnostics.length, 1);
      assert.strictEqual(result.diagnostics[0].code, 'secret-like-content');
      assert.strictEqual(result.diagnostics[0].resourceId, 'review');
      assert.ok(result.diagnostics[0].message.includes('[REDACTED]'));
      assert.ok(!result.diagnostics[0].message.includes('super-secret-value'));
    });

    test('local-only references produce warnings for all resource kinds', () => {
      const localOnlyContent = 'Run from /Users/alice/scripts/run.sh';

      for (const { kind, id } of resourceKinds) {
        const resource: Resource = { kind, id, sourcePath: `${id}.md`, content: localOnlyContent };
        const result = validateRepositoryInstallPolicy({ commitMode: 'commit', resources: [resource] });

        assert.strictEqual(result.allowed, false, `${kind} ${id} should be rejected for local-only reference`);
        assert.ok(result.diagnostics.some((d) => d.code === 'local-only-reference'), `${kind} ${id} should have local-only-reference diagnostic`);
      }
    });
  });
});
