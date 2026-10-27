/**
 * Tests for the primitive diagnostics evaluators.
 *
 * Bundle inputs are governed archives built in memory from the core
 * fixture (`createPrimitiveReleaseArchive`, plan decision D1).
 */
import {
  dump as dumpYaml,
  load as parseYaml,
} from 'js-yaml';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  LEGACY_RELEASE_WARNING,
} from '../../../../src/domain/collection/release-manifest-plan';
import {
  buildPrimitiveFixture,
  type BundleEvaluation,
  type CaseObservation,
  type CommandObservation,
  type DiagnosticBundle,
  type DiagnosticCheck,
  evaluateBundle,
  evaluateCase,
  NOT_EVALUATED,
  type PlannedCase,
  planPrimitiveDiagnostics,
  PRIMITIVE_DIAGNOSTIC_BUNDLES,
  type Snapshot,
} from '../../../../src/domain/diagnostics/primitives';
import type {
  TargetType,
} from '../../../../src/domain/install/target';
import type {
  PrimitiveKind,
} from '../../../../src/domain/primitive/types';
import type {
  ExtractedFiles,
} from '../../../../src/ports/bundle-extractor';
import {
  createPrimitiveReleaseArchive,
} from '../../../fixtures/release-archives';

const fixture = buildPrimitiveFixture();
const bundleOf = (kind: PrimitiveKind): DiagnosticBundle => PRIMITIVE_DIAGNOSTIC_BUNDLES.find((b) => b.items[0].kind === kind)!;
const skill = bundleOf('skill');
const ok: CommandObservation = { exitCode: 0, status: 'ok', warnings: [], errorMessages: [] };
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const withManifest = (archive: ExtractedFiles, mutate: (m: Record<string, unknown>) => void): ExtractedFiles => {
  const manifest = parseYaml(new TextDecoder().decode(archive.get('deployment-manifest.yml'))) as Record<string, unknown>;
  mutate(manifest);
  return new Map([...archive, ['deployment-manifest.yml', text(dumpYaml(manifest))]]);
};

const byInvariant = (checks: readonly DiagnosticCheck[], invariant: string): DiagnosticCheck =>
  checks.find((c) => c.invariant === invariant)!;

describe('evaluateBundle', () => {
  it('passes I0–I3 for a governed archive and lists the archived item files', () => {
    const evaluation = evaluateBundle({ bundle: skill, validate: ok, build: ok, archive: createPrimitiveReleaseArchive(skill, fixture) });
    expect(evaluation.checks.map((c) => [c.invariant, c.outcome, c.item])).toEqual([
      ['I0', 'pass', undefined],
      ['I1', 'pass', 'skills/standalone-skill/SKILL.md'],
      ['I2', 'pass', 'skills/standalone-skill/SKILL.md'],
      ['I3', 'pass', undefined]
    ]);
    expect(evaluation.ready).toBe(true);
    expect([...evaluation.archivedItemFiles]).toEqual([['skills/standalone-skill/SKILL.md', [
      'skills/standalone-skill/SKILL.md',
      'skills/standalone-skill/references/guide.md',
      'skills/standalone-skill/scripts/run.sh'
    ]]]);
  });

  describe('I0', () => {
    it('fails on a build error and cascades NOT_EVALUATED to I1–I3', () => {
      const evaluation = evaluateBundle({
        bundle: skill,
        validate: ok,
        build: { exitCode: 1, status: 'error', warnings: [], errorCode: 'BUNDLE.BUILD_FAILED', errorMessages: ['boom at /abs/path'] }
      });
      expect(evaluation.checks[0]).toMatchObject({
        invariant: 'I0',
        outcome: 'fail',
        observed: {
          validateExit: 0,
          buildExit: 1,
          buildWarnings: [],
          manifestPresent: false,
          formatVersion: null,
          manifestId: null,
          manifestVersion: null,
          firstError: { command: 'build', code: 'BUNDLE.BUILD_FAILED' }
        }
      });
      expect(evaluation.checks[0].detail).toContain('boom at /abs/path');
      expect(evaluation.checks.slice(1)).toEqual(['I1', 'I2', 'I3'].map((invariant) => ({
        invariant, outcome: 'fail', observed: NOT_EVALUATED, detail: 'not evaluated: build failed'
      })));
      expect(evaluation.ready).toBe(false);
      expect(evaluation.archivedItemFiles.size).toBe(0);
    });

    it('fails on a validate rejection without a code, keeping the message out of observed', () => {
      const message = 'collections/x.yml: items[0] referenced file not found: prompts/x.md';
      const evaluation = evaluateBundle({
        bundle: skill,
        validate: { exitCode: 1, status: 'error', warnings: [], errorMessages: [message] },
        build: ok,
        archive: createPrimitiveReleaseArchive(skill, fixture)
      });
      const i0 = evaluation.checks[0];
      expect(i0.outcome).toBe('fail');
      expect(i0.observed).toMatchObject({ validateExit: 1, buildExit: 0, firstError: { command: 'validate', code: null } });
      expect(i0.detail).toContain(message);
      expect(JSON.stringify(i0.observed)).not.toContain('referenced file not found');
      expect(evaluation.ready).toBe(false);
    });

    it('fails when the build fell back to the legacy release path', () => {
      const evaluation = evaluateBundle({
        bundle: skill,
        validate: ok,
        build: { ...ok, status: 'warning', warnings: [LEGACY_RELEASE_WARNING] },
        archive: createPrimitiveReleaseArchive(skill, fixture)
      });
      expect(evaluation.checks[0]).toMatchObject({ outcome: 'fail', observed: { buildWarnings: [LEGACY_RELEASE_WARNING], firstError: null } });
      expect(evaluation.checks[0].detail).toContain('LEGACY_RELEASE_WARNING');
    });

    it('reports an unreadable archive as manifestPresent false', () => {
      const evaluation = evaluateBundle({ bundle: skill, validate: ok, build: ok, archiveError: 'invalid zip: bad central directory' });
      expect(evaluation.checks[0]).toMatchObject({ outcome: 'fail', observed: { manifestPresent: false, firstError: null } });
      expect(evaluation.checks[0].detail).toContain('invalid zip: bad central directory');
    });

    it('fails on an archive without a manifest or with a non-mapping manifest', () => {
      const archive = createPrimitiveReleaseArchive(skill, fixture);
      const noManifest = new Map([...archive].filter(([p]) => p !== 'deployment-manifest.yml'));
      expect(evaluateBundle({ bundle: skill, validate: ok, build: ok, archive: noManifest }).checks[0])
        .toMatchObject({ outcome: 'fail', observed: { manifestPresent: false } });
      const notMapping = new Map([...archive, ['deployment-manifest.yml', text('- a\n')]]);
      const i0 = evaluateBundle({ bundle: skill, validate: ok, build: ok, archive: notMapping }).checks[0];
      expect(i0).toMatchObject({ outcome: 'fail', observed: { manifestPresent: true, formatVersion: null, manifestId: null } });
      expect(i0.detail).toContain('mapping');
    });

    it('fails on a changed manifest id', () => {
      const archive = withManifest(createPrimitiveReleaseArchive(skill, fixture), (m) => {
        m.id = 'aph-e2e-other';
      });
      expect(evaluateBundle({ bundle: skill, validate: ok, build: ok, archive }).checks[0])
        .toMatchObject({ outcome: 'fail', observed: { manifestPresent: true, formatVersion: 1, manifestId: 'aph-e2e-other', manifestVersion: '1.0.0' } });
    });

    it('caps detail at 500 characters', () => {
      const evaluation = evaluateBundle({
        bundle: skill,
        validate: ok,
        build: { exitCode: 1, status: 'error', warnings: [], errorCode: 'X', errorMessages: ['m'.repeat(2000)] }
      });
      expect(evaluation.checks[0].detail!.length).toBeLessThanOrEqual(500);
    });

    const NO_README = 'collections/x.collection.yml: Collection has no readme. Consider adding a readme to help users understand this collection.';
    const ROUTE_MISMATCH = 'collections/x.collection.yml: items[0] plugins/p/skills/s/SKILL.md: kind "skill" differs from the kind '
      + '"plugin" of the install route "plugins/" that this path matches';

    it('passes without a warnings key when validate reports only other warnings', () => {
      const evaluation = evaluateBundle({
        bundle: skill,
        validate: { ...ok, status: 'warning', warnings: [NO_README] },
        build: ok,
        archive: createPrimitiveReleaseArchive(skill, fixture)
      });
      expect(evaluation.checks[0]).toEqual({ invariant: 'I0', outcome: 'pass' });
    });

    it('passes and carries only the kind/route mismatch warnings from validate', () => {
      const evaluation = evaluateBundle({
        bundle: skill,
        validate: { ...ok, status: 'warning', warnings: [ROUTE_MISMATCH, NO_README] },
        build: ok,
        archive: createPrimitiveReleaseArchive(skill, fixture)
      });
      expect(evaluation.checks[0]).toEqual({ invariant: 'I0', outcome: 'pass', warnings: [ROUTE_MISMATCH] });
    });
  });

  describe('I3 (independent of I0)', () => {
    const i3 = (archive: ExtractedFiles): BundleEvaluation => evaluateBundle({ bundle: skill, validate: ok, build: ok, archive });

    it('reports a changed installable file as a size and digest mismatch', () => {
      const archive = new Map([...createPrimitiveReleaseArchive(skill, fixture), ['skills/standalone-skill/SKILL.md', text('tampered')]]);
      const evaluation = i3(archive);
      expect(byInvariant(evaluation.checks, 'I3')).toMatchObject({
        outcome: 'fail',
        observed: {
          code: 'BUNDLE.MANIFEST_INVALID',
          missing: [],
          sizeMismatch: ['skills/standalone-skill/SKILL.md'],
          digestMismatch: ['skills/standalone-skill/SKILL.md'],
          unlisted: []
        }
      });
      expect(byInvariant(evaluation.checks, 'I3').detail).toContain('does not match archive content');
      expect(byInvariant(evaluation.checks, 'I1').outcome).toBe('pass');
      expect(byInvariant(evaluation.checks, 'I2').outcome).toBe('pass');
      expect(evaluation.ready).toBe(true);
    });

    it('reports an extra entry as unlisted', () => {
      const evaluation = i3(new Map([...createPrimitiveReleaseArchive(skill, fixture), ['extra.txt', text('x')]]));
      expect(byInvariant(evaluation.checks, 'I3').observed).toMatchObject({ unlisted: ['extra.txt'], missing: [] });
      expect(evaluation.ready).toBe(true);
    });

    it('reports a removed entry as missing, and I1 still evaluates', () => {
      const removed = 'skills/standalone-skill/references/guide.md';
      const evaluation = i3(new Map([...createPrimitiveReleaseArchive(skill, fixture)].filter(([p]) => p !== removed)));
      expect(byInvariant(evaluation.checks, 'I3').observed).toMatchObject({ missing: [removed], unlisted: [] });
      expect(byInvariant(evaluation.checks, 'I1')).toMatchObject({ outcome: 'fail', observed: { missingArchivePaths: [removed] } });
      expect(evaluation.ready).toBe(true);
    });
  });

  describe('I1 / I2', () => {
    it('reports the power directory unit drop and the stem id (power-directory-unit)', () => {
      const power = bundleOf('power');
      const archive = createPrimitiveReleaseArchive(power, fixture, {
        omitFiles: ['powers/stripe/steering/payments.md'],
        itemIds: { 'powers/stripe/POWER.md': 'POWER' }
      });
      const evaluation = evaluateBundle({ bundle: power, validate: ok, build: ok, archive });
      expect(evaluation.checks.map((c) => [c.invariant, c.outcome, c.observed])).toEqual([
        ['I0', 'pass', undefined],
        ['I1', 'fail', { missingArchivePaths: ['powers/stripe/steering/payments.md'] }],
        ['I2', 'fail', { id: 'POWER', kind: 'power', occurrences: 1 }],
        ['I3', 'pass', undefined]
      ]);
      expect(evaluation.archivedItemFiles.get('powers/stripe/POWER.md')).toEqual(['powers/stripe/POWER.md']);
    });

    it('reports a double-extension prompt id (manifest-id-file-stem)', () => {
      const prompt = bundleOf('prompt');
      const archive = createPrimitiveReleaseArchive(prompt, fixture, { itemIds: { 'prompts/hello-world.prompt.md': 'hello-world.prompt' } });
      expect(byInvariant(evaluateBundle({ bundle: prompt, validate: ok, build: ok, archive }).checks, 'I2')).toEqual({
        invariant: 'I2',
        outcome: 'fail',
        item: 'prompts/hello-world.prompt.md',
        expected: { id: 'hello-world', kind: 'prompt', occurrences: 1 },
        observed: { id: 'hello-world.prompt', kind: 'prompt', occurrences: 1 },
        detail: expect.any(String)
      });
    });

    it('reports an item missing from the manifest', () => {
      const archive = withManifest(createPrimitiveReleaseArchive(skill, fixture), (m) => {
        m.items = [];
      });
      expect(byInvariant(evaluateBundle({ bundle: skill, validate: ok, build: ok, archive }).checks, 'I2').observed)
        .toEqual({ id: null, kind: null, occurrences: 0 });
    });
  });
});

const plan = planPrimitiveDiagnostics({});
const caseOf = (kind: PrimitiveKind, target: TargetType, scope: 'user' | 'repository'): PlannedCase =>
  plan.cases.find((c) => c.id === `aph-e2e-only-${kind}__${target}__${scope}`)!;
const readyEvaluation = (bundle: DiagnosticBundle): BundleEvaluation =>
  evaluateBundle({ bundle, validate: ok, build: ok, archive: createPrimitiveReleaseArchive(bundle, fixture) });

const BOOKKEEPING = { target: '<workspace>/ai-primitives-hub.yml', lock: '$XDG_CONFIG_HOME/ai-primitives-hub/ai-primitives-hub.lock.json' };
const snap = (...labels: string[]): Snapshot => new Map(labels.map((l) => [l, 'h']));

const installed = (kind: PrimitiveKind, placed: readonly string[], overrides: Partial<CaseObservation> = {}): CaseObservation => ({
  targetAdd: { ...ok, effectiveScope: 'user' },
  install: ok,
  uninstall: ok,
  snapshots: {
    beforeInstall: snap(BOOKKEEPING.target),
    afterInstall: snap(BOOKKEEPING.target, BOOKKEEPING.lock, ...placed),
    afterUninstall: snap(BOOKKEEPING.target, BOOKKEEPING.lock)
  },
  ...overrides
});

const rejected = (errorCode: string, writes: readonly string[] = []): CaseObservation => ({
  targetAdd: { ...ok, effectiveScope: 'user' },
  install: { exitCode: 1, status: 'error', warnings: [], errorCode, errorMessages: ['nope'] },
  snapshots: { beforeInstall: snap(BOOKKEEPING.target), afterInstall: snap(BOOKKEEPING.target, ...writes) }
});

const summary = (checks: readonly DiagnosticCheck[]): [string, string][] => checks.map((c) => [c.invariant, c.outcome]);

describe('evaluateCase', () => {
  const prompt = bundleOf('prompt');
  const promptEvaluation = readyEvaluation(prompt);

  it('passes an installed prompt in the order I4, I6, I7, I8, I13', () => {
    const checks = evaluateCase(caseOf('prompt', 'vscode', 'user'), prompt, promptEvaluation,
      installed('prompt', ['$HOME/.copilot/prompts/hello-world.prompt.md']));
    expect(summary(checks)).toEqual([['I4', 'pass'], ['I6', 'pass'], ['I7', 'not-applicable'], ['I8', 'pass'], ['I13', 'pass']]);
    expect(checks[0].expected).toEqual({ status: 'installed' });
  });

  it('passes a by-design rejection (steering on vscode)', () => {
    const steering = bundleOf('steering');
    const checks = evaluateCase(caseOf('steering', 'vscode', 'user'), steering, readyEvaluation(steering), rejected('BUNDLE.UNSUPPORTED_CONTENT'));
    expect(summary(checks)).toEqual([['I4', 'pass'], ['I6', 'not-applicable'], ['I7', 'pass'], ['I8', 'pass'], ['I13', 'not-applicable']]);
    expect(checks[0].expected).toEqual({ status: 'rejected' });
  });

  it('classifies an unexpected error as status error', () => {
    const checks = evaluateCase(caseOf('prompt', 'vscode', 'user'), prompt, promptEvaluation, rejected('INTERNAL.UNEXPECTED'));
    expect(checks[0]).toMatchObject({ invariant: 'I4', outcome: 'fail', expected: { status: 'installed' }, observed: { status: 'error', errorCode: 'INTERNAL.UNEXPECTED' } });
  });

  it('reports an unsupported-content rejection on a supported cell as rejected', () => {
    const mcp = bundleOf('mcp-server');
    const checks = evaluateCase(caseOf('mcp-server', 'vscode', 'user'), mcp, readyEvaluation(mcp), rejected('BUNDLE.UNSUPPORTED_CONTENT'));
    expect(checks[0]).toMatchObject({ outcome: 'fail', observed: { status: 'rejected', errorCode: 'BUNDLE.UNSUPPORTED_CONTENT' } });
  });

  it('I6: fails on a file left behind by uninstall', () => {
    const placed = '$HOME/.copilot/prompts/hello-world.prompt.md';
    const observation = installed('prompt', [placed]);
    observation.snapshots.afterUninstall = snap(BOOKKEEPING.target, BOOKKEEPING.lock, placed);
    expect(byInvariant(evaluateCase(caseOf('prompt', 'vscode', 'user'), prompt, promptEvaluation, observation), 'I6'))
      .toMatchObject({ outcome: 'fail', observed: { exitCode: 0, remaining: [placed] } });
  });

  it('I6: fails on a failing uninstall', () => {
    const observation = installed('prompt', ['$HOME/.copilot/prompts/hello-world.prompt.md'], { uninstall: { ...ok, exitCode: 1 } });
    expect(byInvariant(evaluateCase(caseOf('prompt', 'vscode', 'user'), prompt, promptEvaluation, observation), 'I6'))
      .toMatchObject({ outcome: 'fail', observed: { exitCode: 1, remaining: [] } });
  });

  it('I7: fails on a rejected install that wrote a user-facing file', () => {
    const steering = bundleOf('steering');
    const checks = evaluateCase(caseOf('steering', 'vscode', 'user'), steering, readyEvaluation(steering),
      rejected('BUNDLE.UNSUPPORTED_CONTENT', ['$HOME/.copilot/x.md', '$TMPDIR/scratch']));
    expect(byInvariant(checks, 'I7')).toMatchObject({ outcome: 'fail', observed: { changed: ['$HOME/.copilot/x.md'] } });
  });

  it('I8: fails when copilot-cli rewrites repository scope to user, and I13 follows the effective scope', () => {
    const checks = evaluateCase(caseOf('prompt', 'copilot-cli', 'repository'), prompt, promptEvaluation,
      installed('prompt', ['$HOME/.copilot/prompts/hello-world.prompt.md']));
    expect(byInvariant(checks, 'I8')).toMatchObject({ outcome: 'fail', expected: { effectiveScope: 'repository' }, observed: { effectiveScope: 'user' } });
    expect(byInvariant(checks, 'I13').outcome).toBe('pass');
  });

  it('I13: reports a moved route as missing + unexpected', () => {
    const checks = evaluateCase(caseOf('prompt', 'kiro', 'user'), prompt, promptEvaluation,
      installed('prompt', ['$HOME/.kiro/prompts/hello-world.prompt.md']));
    expect(byInvariant(checks, 'I13')).toMatchObject({
      outcome: 'fail',
      observed: { missing: ['$HOME/.kiro/steering/hello-world.prompt.md'], unexpected: ['$HOME/.kiro/prompts/hello-world.prompt.md'] }
    });
  });

  it('I13: compares the whole skill tree at repository scope', () => {
    const files = ['SKILL.md', 'references/guide.md', 'scripts/run.sh'].map((f) => `<workspace>/.github/skills/standalone-skill/${f}`);
    const observation = installed('skill', files);
    observation.targetAdd = { ...ok, effectiveScope: 'repository' };
    expect(byInvariant(evaluateCase(caseOf('skill', 'vscode', 'repository'), skill, readyEvaluation(skill), observation), 'I13').outcome)
      .toBe('pass');
  });

  it('I13: counts a modified pre-existing file and a <case> write', () => {
    const placed = '$HOME/.copilot/prompts/hello-world.prompt.md';
    const observation = installed('prompt', [placed, '<case>/stray']);
    observation.snapshots.beforeInstall = snap(BOOKKEEPING.target, '$HOME/.copilot/existing.md');
    observation.snapshots.afterInstall = new Map([...snap(BOOKKEEPING.target, BOOKKEEPING.lock, placed, '<case>/stray'), ['$HOME/.copilot/existing.md', 'changed']]);
    expect(byInvariant(evaluateCase(caseOf('prompt', 'vscode', 'user'), prompt, promptEvaluation, observation), 'I13').observed)
      .toEqual({ missing: [], unexpected: ['$HOME/.copilot/existing.md', '<case>/stray'] });
  });

  it('I13: is not applicable for config-routed items or an unknown effective scope', () => {
    const mcp = bundleOf('mcp-server');
    const config = evaluateCase(caseOf('mcp-server', 'vscode', 'user'), mcp, readyEvaluation(mcp), installed('mcp-server', []));
    expect(byInvariant(config, 'I13').outcome).toBe('not-applicable');

    const observation = installed('prompt', ['$HOME/.copilot/prompts/hello-world.prompt.md']);
    observation.targetAdd = { ...ok, effectiveScope: 'global' };
    const unknown = evaluateCase(caseOf('prompt', 'vscode', 'user'), prompt, promptEvaluation, observation);
    expect(byInvariant(unknown, 'I8')).toMatchObject({ outcome: 'fail', observed: { effectiveScope: 'global' } });
    expect(byInvariant(unknown, 'I13')).toMatchObject({ outcome: 'not-applicable', detail: 'unknown effective scope' });
  });

  it('keeps raw messages and absolute paths out of observed', () => {
    const observation = rejected('INTERNAL.UNEXPECTED');
    observation.install = { ...observation.install!, errorMessages: ['failed writing /home/me/.copilot/x'] };
    const checks = evaluateCase(caseOf('prompt', 'vscode', 'user'), prompt, promptEvaluation, observation);
    expect(JSON.stringify(checks.map((c) => c.observed))).not.toContain('/home/me');
  });
});
