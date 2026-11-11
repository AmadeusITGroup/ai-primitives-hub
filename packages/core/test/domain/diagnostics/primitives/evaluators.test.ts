/**
 * Tests for the primitive diagnostics evaluators.
 *
 * Bundle inputs are governed archives built in memory from the core
 * fixture (`createPrimitiveReleaseArchive`, plan decision D1).
 */
import * as path from 'node:path';
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
  evaluateArchiveModes,
  evaluateBundle,
  evaluateCase,
  evaluateRejectedBundle,
  expectedDestination,
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
import type {
  SnapshotRoot,
} from '../../../../src/ports/primitive-diagnostics-driver';
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

describe('evaluateRejectedBundle (I5)', () => {
  const message = 'collections/bad.collection.yml: items[0] plugin plugins/bad/plugin.json: missing required field "$schema"';
  const invalid: DiagnosticBundle = {
    ...bundleOf('prompt'),
    id: 'bad',
    collectionFile: 'collections/bad.collection.yml',
    rejection: { errorCode: 'PLUGIN.INVALID_MANIFEST', message }
  };
  const validateRejected: CommandObservation = { exitCode: 1, status: 'error', warnings: [], errorMessages: [message] };
  const buildRejected: CommandObservation = { exitCode: 1, status: 'error', warnings: [], errorCode: 'PLUGIN.INVALID_MANIFEST', errorMessages: [message] };
  const expected = {
    validateRejected: true, validateReported: true, buildRejected: true, buildErrorCode: 'PLUGIN.INVALID_MANIFEST', buildReported: true, written: []
  };

  it('passes when validate and build reject with the documented message and nothing is written', () => {
    const evaluation = evaluateRejectedBundle({ bundle: invalid, validate: validateRejected, build: buildRejected, distWrites: [] });
    expect(evaluation).toEqual({ checks: [{ invariant: 'I5', outcome: 'pass', expected }], ready: false, archivedItemFiles: new Map() });
  });

  it.each([
    ['validate accepts it', { validate: ok }, { validateRejected: false, validateReported: false }],
    ['validate reports another message', { validate: { ...validateRejected, errorMessages: ['other'] } }, { validateReported: false }],
    ['build succeeds', { build: ok }, { buildRejected: false, buildErrorCode: null, buildReported: false }],
    ['build fails with another code', { build: { ...buildRejected, errorCode: 'BUNDLE.BUILD_FAILED' } }, { buildErrorCode: 'BUNDLE.BUILD_FAILED' }],
    ['build writes into the dist dir', { distWrites: ['<dist>/bad-1.0.0.zip'] }, { written: ['<dist>/bad-1.0.0.zip'] }]
  ] as const)('fails when %s', (_name, override, observedDelta) => {
    const [check] = evaluateRejectedBundle({ bundle: invalid, validate: validateRejected, build: buildRejected, distWrites: [], ...override }).checks;
    expect(check).toMatchObject({ invariant: 'I5', outcome: 'fail', expected, observed: { ...expected, ...observedDelta } });
    expect(check.detail).toBeDefined();
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

const rejected = (errorCode: string, writes: readonly string[] = [], rejectedPaths?: readonly string[]): CaseObservation => ({
  targetAdd: { ...ok, effectiveScope: 'user' },
  install: { exitCode: 1, status: 'error', warnings: [], errorCode, errorMessages: ['nope'], ...(rejectedPaths === undefined ? {} : { rejectedPaths }) },
  snapshots: { beforeInstall: snap(BOOKKEEPING.target), afterInstall: snap(BOOKKEEPING.target, ...writes) }
});

const summary = (checks: readonly DiagnosticCheck[]): [string, string][] => checks.map((c) => [c.invariant, c.outcome]);

describe('evaluateCase', () => {
  const prompt = bundleOf('prompt');
  const promptEvaluation = readyEvaluation(prompt);

  it('passes an installed prompt in the order I4, I6, I7, I8, I9, I13', () => {
    const checks = evaluateCase(caseOf('prompt', 'vscode', 'user'), prompt, promptEvaluation,
      installed('prompt', ['$HOME/.copilot/prompts/hello-world.prompt.md']));
    expect(summary(checks)).toEqual([['I4', 'pass'], ['I6', 'pass'], ['I7', 'not-applicable'], ['I8', 'pass'], ['I9', 'not-applicable'], ['I13', 'pass']]);
    expect(checks[0].expected).toEqual({ status: 'installed' });
  });

  it('passes a by-design rejection (steering on vscode)', () => {
    const steering = bundleOf('steering');
    const checks = evaluateCase(caseOf('steering', 'vscode', 'user'), steering, readyEvaluation(steering),
      rejected('BUNDLE.UNSUPPORTED_CONTENT', [], ['.kiro/steering/api-standards.md']));
    expect(summary(checks)).toEqual([['I4', 'pass'], ['I6', 'not-applicable'], ['I7', 'pass'], ['I8', 'pass'], ['I9', 'pass'], ['I13', 'not-applicable']]);
    expect(checks[0].expected).toEqual({ status: 'rejected' });
    expect(byInvariant(checks, 'I9')).toEqual({ invariant: 'I9', outcome: 'pass', item: '.kiro/steering/api-standards.md', expected: { rejected: true } });
  });

  describe('I9', () => {
    const mcp = bundleOf('mcp-server');
    const steering = bundleOf('steering');
    const mix: DiagnosticBundle = { ...prompt, id: 'mix', items: [prompt.items[0], steering.items[0]] };
    const mixCase = planPrimitiveDiagnostics({ targets: ['vscode'], scopes: ['user'] }, [mix]).cases[0];

    it('fails with rejected true for an item of a supported kind the install rejected', () => {
      const checks = evaluateCase(caseOf('mcp-server', 'vscode', 'user'), mcp, readyEvaluation(mcp),
        rejected('BUNDLE.UNSUPPORTED_CONTENT', [], ['mcp-servers/github.mcp.json']));
      expect(byInvariant(checks, 'I9')).toMatchObject({
        outcome: 'fail', item: 'mcp-servers/github.mcp.json', expected: { rejected: false }, observed: { rejected: true }
      });
    });

    it('observes rejected null when the install did not list the rejected paths', () => {
      const checks = evaluateCase(caseOf('steering', 'vscode', 'user'), steering, readyEvaluation(steering), rejected('BUNDLE.UNSUPPORTED_CONTENT'));
      expect(byInvariant(checks, 'I9')).toMatchObject({ outcome: 'fail', observed: { rejected: null } });
    });

    it('checks every item of a mixed bundle, and names paths that belong to no item', () => {
      const checks = evaluateCase(mixCase, mix, readyEvaluation(mix),
        rejected('BUNDLE.UNSUPPORTED_CONTENT', [], ['.kiro/steering/api-standards.md', 'stray/file.md']));
      const i9 = checks.filter((c) => c.invariant === 'I9');
      expect(i9.map((c) => [c.item, c.outcome])).toEqual([
        ['prompts/hello-world.prompt.md', 'pass'],
        ['.kiro/steering/api-standards.md', 'pass']
      ]);
      expect(i9[0].detail).toContain('stray/file.md');
    });

    it('fails an item of a supported kind rejected along with an unsupported one', () => {
      const checks = evaluateCase(mixCase, mix, readyEvaluation(mix),
        rejected('BUNDLE.UNSUPPORTED_CONTENT', [], ['.kiro/steering/api-standards.md', 'prompts/hello-world.prompt.md']));
      expect(checks.filter((c) => c.invariant === 'I9').map((c) => [c.item, c.outcome, c.observed])).toEqual([
        ['prompts/hello-world.prompt.md', 'fail', { rejected: true }],
        ['.kiro/steering/api-standards.md', 'pass', undefined]
      ]);
      // The default install is all-or-nothing: the rejection itself is expected.
      expect(byInvariant(checks, 'I4')).toEqual({ invariant: 'I4', outcome: 'pass', expected: { status: 'rejected' } });
    });
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

describe('evaluateCase with --skip-unsupported', () => {
  const prompt = bundleOf('prompt');
  const instruction = bundleOf('instruction');
  const steering = bundleOf('steering');
  const plugin = bundleOf('plugin');
  const UNSUPPORTED = 'BUNDLE.UNSUPPORTED_CONTENT';
  const mixOf = (...bundles: DiagnosticBundle[]): DiagnosticBundle => ({ ...prompt, id: 'mix', items: bundles.map((b) => b.items[0]) });
  const skipCaseOf = (mix: DiagnosticBundle): PlannedCase =>
    planPrimitiveDiagnostics({ targets: ['vscode'], scopes: ['user'] }, [mix]).cases.find((c) => c.mode === 'skip-unsupported')!;
  // User-scope vscode destinations of the item files, as the placement oracle gives them.
  const placedFor = (...bundles: DiagnosticBundle[]): string[] => bundles.flatMap((b) => b.items[0].files.flatMap((file) => {
    const destination = expectedDestination('vscode', 'user', b.items[0], file);
    return destination.kind === 'file' ? [destination.label] : [];
  }));
  const skippedFor = (...bundles: DiagnosticBundle[]): { path: string; code: string; reason: string }[] =>
    bundles.flatMap((b) => b.items[0].files).map((file) => ({ path: file, code: UNSUPPORTED, reason: 'target "tgt" (vscode) cannot install this content' }));
  const filesOf = (...bundles: DiagnosticBundle[]): string[] => bundles.flatMap((b) => b.items[0].files);
  const partial = (
    placed: readonly string[],
    skipped: { path: string; code: string; reason: string }[],
    lockedFiles?: readonly string[]
  ): CaseObservation => installed('prompt', placed, {
    install: { ...ok, status: 'warning', skipped },
    ...(lockedFiles === undefined ? {} : { lockedFiles })
  });

  const promptSteering = mixOf(prompt, steering);
  const promptSteeringCase = skipCaseOf(promptSteering);
  const promptSteeringEvaluation = readyEvaluation(promptSteering);

  it('passes a partial install: the supported items placed, the others skipped with a reason, the lockfile listing the installed files', () => {
    expect(promptSteeringCase).toMatchObject({ id: 'mix__vscode__user__skip-unsupported', mode: 'skip-unsupported', expectedStatus: 'partial' });
    const checks = evaluateCase(promptSteeringCase, promptSteering, promptSteeringEvaluation,
      partial(placedFor(prompt), skippedFor(steering), filesOf(prompt)));
    expect(checks.map((c) => [c.invariant, c.outcome, c.item])).toEqual([
      ['I4', 'pass', undefined],
      ['I6', 'pass', undefined],
      ['I7', 'not-applicable', undefined],
      ['I8', 'pass', undefined],
      ['I9', 'pass', 'prompts/hello-world.prompt.md'],
      ['I9', 'pass', '.kiro/steering/api-standards.md'],
      ['I13', 'pass', undefined],
      ['I15', 'pass', undefined]
    ]);
    expect(byInvariant(checks, 'I4').expected).toEqual({ status: 'partial' });
    expect(checks.filter((c) => c.invariant === 'I9').map((c) => c.expected)).toEqual([{ rejected: false }, { rejected: true }]);
    expect(byInvariant(checks, 'I15').expected).toEqual({ unreasoned: [], missing: [], unexpected: [] });
  });

  it('fails I4 with status partial and no error code when the matrix expects every item installed', () => {
    const both = mixOf(prompt, instruction);
    const checks = evaluateCase(skipCaseOf(both), both, readyEvaluation(both), partial(placedFor(prompt), skippedFor(instruction), filesOf(prompt)));
    expect(byInvariant(checks, 'I4')).toMatchObject({ outcome: 'fail', expected: { status: 'installed' }, observed: { status: 'partial', errorCode: null } });
    expect(byInvariant(checks, 'I6').outcome).toBe('pass');
    expect(byInvariant(checks, 'I7')).toMatchObject({ outcome: 'not-applicable', detail: 'not applicable: install partial' });
  });

  it('fails I9 for a supported item that was skipped, and I13 checks only what was installed', () => {
    const mix = mixOf(prompt, instruction, steering);
    const checks = evaluateCase(skipCaseOf(mix), mix, readyEvaluation(mix),
      partial(placedFor(instruction), skippedFor(prompt, steering), filesOf(instruction)));
    expect(checks.filter((c) => c.invariant === 'I9').map((c) => [c.item, c.outcome, c.observed])).toEqual([
      ['prompts/hello-world.prompt.md', 'fail', { rejected: true }],
      ['instructions/code-style.instructions.md', 'pass', undefined],
      ['.kiro/steering/api-standards.md', 'pass', undefined]
    ]);
    expect(byInvariant(checks, 'I13').outcome).toBe('pass');
    expect(byInvariant(checks, 'I15').outcome).toBe('pass');
  });

  it('fails I9 for an unsupported item that was installed, counting an absent skipped list as empty', () => {
    const observation = installed('prompt', placedFor(prompt), { install: ok, lockedFiles: filesOf(prompt) });
    const checks = evaluateCase(promptSteeringCase, promptSteering, promptSteeringEvaluation, observation);
    expect(byInvariant(checks, 'I4')).toMatchObject({ outcome: 'fail', observed: { status: 'installed', errorCode: null } });
    expect(checks.filter((c) => c.invariant === 'I9').map((c) => [c.item, c.outcome, c.observed])).toEqual([
      ['prompts/hello-world.prompt.md', 'pass', undefined],
      ['.kiro/steering/api-standards.md', 'fail', { rejected: false }]
    ]);
  });

  it.each([
    ['a skipped file without the unsupported-content code', [{ path: '.kiro/steering/api-standards.md', code: 'FS.WRITE_FAILED', reason: 'x' }], ['prompts/hello-world.prompt.md'],
      { unreasoned: ['.kiro/steering/api-standards.md'], missing: [], unexpected: [] }],
    ['a skipped file without a reason', [{ path: '.kiro/steering/api-standards.md', code: UNSUPPORTED, reason: ' ' }], ['prompts/hello-world.prompt.md'],
      { unreasoned: ['.kiro/steering/api-standards.md'], missing: [], unexpected: [] }],
    ['a lockfile that records a skipped file', undefined, ['.kiro/steering/api-standards.md', 'prompts/hello-world.prompt.md'],
      { unreasoned: [], missing: [], unexpected: ['.kiro/steering/api-standards.md'] }],
    ['a lockfile that misses an installed file', undefined, [],
      { unreasoned: [], missing: ['prompts/hello-world.prompt.md'], unexpected: [] }],
    ['an unread lockfile', undefined, undefined,
      { unreasoned: [], missing: null, unexpected: null }]
  ] as const)('fails I15 for %s', (_name, skipped, lockedFiles, observed) => {
    const checks = evaluateCase(promptSteeringCase, promptSteering, promptSteeringEvaluation,
      partial(placedFor(prompt), skipped === undefined ? skippedFor(steering) : [...skipped], lockedFiles));
    expect(byInvariant(checks, 'I15')).toMatchObject({ outcome: 'fail', expected: { unreasoned: [], missing: [], unexpected: [] }, observed });
  });

  it('is not applicable to a rejected --skip-unsupported install, and checks its I9 by the rejected paths', () => {
    const checks = evaluateCase(promptSteeringCase, promptSteering, promptSteeringEvaluation,
      rejected(UNSUPPORTED, [], filesOf(steering)));
    expect(byInvariant(checks, 'I4')).toMatchObject({ outcome: 'fail', observed: { status: 'rejected', errorCode: UNSUPPORTED } });
    expect(checks.filter((c) => c.invariant === 'I9').map((c) => c.outcome)).toEqual(['pass', 'pass']);
    expect(byInvariant(checks, 'I15')).toMatchObject({ outcome: 'not-applicable', detail: 'not applicable: install rejected' });
  });

  it('makes I11, I12 and I14 not applicable when the plugin was skipped', () => {
    const mix = mixOf(prompt, plugin);
    const checks = evaluateCase(skipCaseOf(mix), mix, readyEvaluation(mix), partial(placedFor(prompt), skippedFor(plugin), filesOf(prompt)));
    expect(['I11', 'I12', 'I14'].map((invariant) => [byInvariant(checks, invariant).outcome, byInvariant(checks, invariant).detail]))
      .toEqual([1, 2, 3].map(() => ['not-applicable', 'not applicable: plugin skipped']));
    expect(byInvariant(checks, 'I10')).toMatchObject({ outcome: 'not-applicable', detail: 'not applicable: no executable file was placed' });
    expect(byInvariant(checks, 'I13').outcome).toBe('pass');
    expect(checks.map((c) => c.invariant).at(-1)).toBe('I15');
  });

  it('adds no I15 check to a default-mode case', () => {
    const defaultCase = planPrimitiveDiagnostics({ targets: ['vscode'], scopes: ['user'] }, [promptSteering]).cases[0];
    expect(defaultCase.mode).toBe('default');
    const checks = evaluateCase(defaultCase, promptSteering, promptSteeringEvaluation, rejected(UNSUPPORTED, [], filesOf(steering)));
    expect(checks.map((c) => c.invariant)).not.toContain('I15');
    const single = evaluateCase(caseOf('prompt', 'vscode', 'user'), prompt, readyEvaluation(prompt), installed('prompt', placedFor(prompt)));
    expect(single.map((c) => c.invariant)).not.toContain('I15');
  });
});

describe('evaluateArchiveModes (bundle-level I10)', () => {
  const run = 'skills/standalone-skill/scripts/run.sh';

  it('passes when every executable fixture file is executable in the archive, and keeps the modes', () => {
    const evaluation = evaluateArchiveModes(skill, readyEvaluation(skill), new Set([run]));
    expect(evaluation.checks.at(-1)).toEqual({ invariant: 'I10', outcome: 'pass', item: 'skills/standalone-skill/SKILL.md' });
    expect(evaluation.executableArchivePaths).toEqual(new Set([run]));
    expect(evaluation.ready).toBe(true);
  });

  it('fails with the archive paths that lost the executable bit', () => {
    expect(evaluateArchiveModes(skill, readyEvaluation(skill), new Set()).checks.at(-1))
      .toMatchObject({ invariant: 'I10', outcome: 'fail', item: 'skills/standalone-skill/SKILL.md', observed: { notExecutable: [run] } });
  });

  it('is not applicable without permission bits, and absent for a bundle without executable files', () => {
    const unknown = evaluateArchiveModes(skill, readyEvaluation(skill), undefined);
    expect(unknown.checks.at(-1)).toMatchObject({ invariant: 'I10', outcome: 'not-applicable' });
    expect(unknown.executableArchivePaths).toBeUndefined();
    const prompt = bundleOf('prompt');
    const evaluation = readyEvaluation(prompt);
    expect(evaluateArchiveModes(prompt, evaluation, new Set())).toBe(evaluation);
  });
});

describe('evaluateCase executable bits (case-level I10)', () => {
  const run = 'skills/standalone-skill/scripts/run.sh';
  const files = ['SKILL.md', 'references/guide.md', 'scripts/run.sh'].map((f) => `$HOME/.copilot/skills/standalone-skill/${f}`);
  const evaluation = evaluateArchiveModes(skill, readyEvaluation(skill), new Set([run]));

  it('passes when the installed script keeps its executable bit', () => {
    const observation = installed('skill', files, { executable: new Set([files[2]]) });
    expect(byInvariant(evaluateCase(caseOf('skill', 'vscode', 'user'), skill, evaluation, observation), 'I10'))
      .toEqual({ invariant: 'I10', outcome: 'pass', item: 'skills/standalone-skill/SKILL.md' });
  });

  it('fails with the archive path of a script installed without its executable bit', () => {
    const observation = installed('skill', files, { executable: new Set() });
    expect(byInvariant(evaluateCase(caseOf('skill', 'vscode', 'user'), skill, evaluation, observation), 'I10'))
      .toMatchObject({ outcome: 'fail', item: 'skills/standalone-skill/SKILL.md', observed: { notExecutable: [run] } });
  });

  it('is not applicable without permission bits or when the install did not succeed', () => {
    const unknown = evaluateCase(caseOf('skill', 'vscode', 'user'), skill, evaluation, installed('skill', files));
    expect(byInvariant(unknown, 'I10')).toMatchObject({ outcome: 'not-applicable' });
    const failed = evaluateCase(caseOf('skill', 'vscode', 'user'), skill, evaluation, rejected('INTERNAL.UNEXPECTED'));
    expect(byInvariant(failed, 'I10')).toMatchObject({ outcome: 'not-applicable' });
  });

  it('does not count a file that was not executable in the archive', () => {
    const lostInArchive = evaluateArchiveModes(skill, readyEvaluation(skill), new Set());
    const observation = installed('skill', files, { executable: new Set() });
    expect(byInvariant(evaluateCase(caseOf('skill', 'vscode', 'user'), skill, lostInArchive, observation), 'I10'))
      .toMatchObject({ outcome: 'not-applicable' });
  });
});

describe('evaluateCase plugin projection (I11, I12, I14)', () => {
  const plugin = bundleOf('plugin');
  const evaluation = readyEvaluation(plugin);
  const home = path.resolve('/w/cases/c1/home');
  const roots: SnapshotRoot[] = [{ label: '$HOME', path: home }, { label: '<workspace>', path: path.resolve('/w/cases/c1/ws') }];
  const pluginRoot = path.join(home, '.copilot', 'plugins', 'aph-e2e-plugin');
  const copied = ['mcp.json', 'plugin.json', 'scripts/launch.sh', 'skills/plugin-skill/SKILL.md'].map((f) => `$HOME/.copilot/plugins/aph-e2e-plugin/${f}`);
  const projectedSkill = '$HOME/.copilot/skills/plugin-skill/SKILL.md';
  const config = '$HOME/.copilot/mcp-config.json';
  const server = (root: string): Record<string, unknown> =>
    ({ type: 'stdio', command: './scripts/launch.sh', args: ['--root', root], env: { APH_E2E_PLUGIN_ROOT: root }, cwd: root });
  const observe = (placed: readonly string[], written: Record<string, string> = {}): CaseObservation =>
    installed('plugin', placed, {
      roots,
      installedText: new Map([
        [copied[0], new TextDecoder().decode(fixture.get('plugins/aph-e2e-plugin/mcp.json')!.bytes)],
        ...Object.entries(written)
      ])
    });
  const run = (observation: CaseObservation): DiagnosticCheck[] => evaluateCase(caseOf('plugin', 'vscode', 'user'), plugin, evaluation, observation);

  it('reports today\'s copy-only install: no skill or MCP projection, ${PLUGIN_ROOT} unresolved, placement as expected', () => {
    const checks = run(observe(copied));
    expect(summary(checks)).toEqual([
      ['I4', 'pass'], ['I6', 'pass'], ['I7', 'not-applicable'], ['I8', 'pass'], ['I9', 'not-applicable'], ['I10', 'not-applicable'],
      ['I11', 'fail'], ['I12', 'fail'], ['I13', 'pass'], ['I14', 'fail']
    ]);
    expect(byInvariant(checks, 'I11')).toMatchObject({ item: plugin.items[0].path, observed: { unprojected: ['plugin-skill'] } });
    expect(byInvariant(checks, 'I12')).toMatchObject({ item: plugin.items[0].path, observed: { unprojected: ['aph-e2e'] } });
    expect(byInvariant(checks, 'I14')).toMatchObject({ item: plugin.items[0].path, observed: { unresolved: ['aph-e2e'] } });
  });

  it('passes a projected and resolved plugin, and I13 accepts the projected files', () => {
    const checks = run(observe([...copied, projectedSkill, config], {
      [projectedSkill]: '---\nname: plugin-skill\n---\n',
      [config]: JSON.stringify({ mcpServers: { 'aph-e2e-plugin:aph-e2e': server(pluginRoot) } })
    }));
    expect(['I11', 'I12', 'I13', 'I14'].map((invariant) => byInvariant(checks, invariant).outcome)).toEqual(['pass', 'pass', 'pass', 'pass']);
  });

  it('expects plugin skills where the target places skill items (Devin user scope: $HOME/.config/devin/skills/)', () => {
    const devinCopied = copied.map((label) => label.replace('$HOME/.copilot/', '$HOME/.devin/'));
    const devin = (skillLabel: string): DiagnosticCheck[] => evaluateCase(caseOf('plugin', 'devin', 'user'), plugin, evaluation,
      installed('plugin', [...devinCopied, skillLabel], { roots, installedText: new Map([[skillLabel, '---\nname: plugin-skill\n---\n']]) }));
    const configSkill = devin('$HOME/.config/devin/skills/plugin-skill/SKILL.md');
    expect(byInvariant(configSkill, 'I11').outcome).toBe('pass');
    expect(byInvariant(configSkill, 'I13').outcome).toBe('pass');
    expect(byInvariant(devin('$HOME/.devin/skills/plugin-skill/SKILL.md'), 'I11'))
      .toMatchObject({ outcome: 'fail', observed: { unprojected: ['plugin-skill'] } });
  });

  it('accepts the plain and __ server name forms, at any depth', () => {
    for (const key of ['aph-e2e', 'aph-e2e-plugin__aph-e2e']) {
      const checks = run(observe([...copied, config], { [config]: JSON.stringify({ servers: { nested: { [key]: server(pluginRoot) } } }) }));
      expect(byInvariant(checks, 'I12').outcome, key).toBe('pass');
    }
  });

  it('fails I14 when a projected server keeps ${PLUGIN_ROOT} or points elsewhere', () => {
    for (const root of ['${PLUGIN_ROOT}', path.resolve('/elsewhere')]) {
      const checks = run(observe([...copied, config], { [config]: JSON.stringify({ mcpServers: { 'aph-e2e': server(root) } }) }));
      expect(byInvariant(checks, 'I12').outcome, root).toBe('pass');
      expect(byInvariant(checks, 'I14'), root).toMatchObject({ outcome: 'fail', observed: { unresolved: ['aph-e2e'] } });
    }
  });

  it('does not count the plugin\'s own mcp.json as a projection, and keeps an unrelated config write unexpected', () => {
    const other = '$HOME/.copilot/other.json';
    const checks = run(observe([...copied, other], { [other]: JSON.stringify({ unrelated: { x: 1 } }) }));
    expect(byInvariant(checks, 'I12').outcome).toBe('fail');
    expect(byInvariant(checks, 'I13')).toMatchObject({ outcome: 'fail', observed: { missing: [], unexpected: [other] } });
  });

  it('is not applicable when the install was rejected, and absent for a bundle without a plugin', () => {
    const kiro = evaluateCase(caseOf('plugin', 'kiro', 'user'), plugin, evaluation,
      rejected('BUNDLE.UNSUPPORTED_CONTENT', [], plugin.items[0].files));
    expect(['I11', 'I12', 'I14'].map((invariant) => byInvariant(kiro, invariant).outcome)).toEqual(['not-applicable', 'not-applicable', 'not-applicable']);
    expect(byInvariant(kiro, 'I9')).toMatchObject({ outcome: 'fail', observed: { rejected: true } });
    const prompt = bundleOf('prompt');
    const checks = evaluateCase(caseOf('prompt', 'vscode', 'user'), prompt, readyEvaluation(prompt),
      installed('prompt', ['$HOME/.copilot/prompts/hello-world.prompt.md']));
    expect(checks.map((c) => c.invariant)).not.toContain('I11');
  });
});
