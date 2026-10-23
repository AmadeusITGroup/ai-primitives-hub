/**
 * Tests for primitive diagnostics report assembly (design §3.9).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  assemblePrimitiveReport,
  type BundleResult,
  type CaseResult,
  type DiagnosticCheck,
  type KnownGap,
  NOT_EVALUATED,
  type PlannedCase,
  planPrimitiveDiagnostics,
  PRIMITIVE_KNOWN_GAPS,
  type PrimitiveReportMeta,
} from '../../../../src/domain/diagnostics/primitives';

/** G17 as seeded on be1d161; #526 fixed it, so it is no longer in PRIMITIVE_KNOWN_GAPS. */
const G17: KnownGap = {
  key: 'G17/I4/chat-mode@copilot-cli',
  id: 'G17',
  invariant: 'I4',
  match: { kinds: ['chat-mode'], targets: ['copilot-cli'] },
  observed: { status: 'rejected', errorCode: 'BUNDLE.UNSUPPORTED_CONTENT' },
  summary: 'copilot-cli rejects chat-mode items'
};
/** The be1d161 seed the fixtures below were recorded against. */
const GAPS: readonly KnownGap[] = [...PRIMITIVE_KNOWN_GAPS.slice(0, 2), G17, ...PRIMITIVE_KNOWN_GAPS.slice(2)];
const plan = planPrimitiveDiagnostics({ kinds: ['prompt', 'chat-mode'], targets: ['vscode', 'copilot-cli'] });
const meta: PrimitiveReportMeta = { workspace: '/tmp/ai-primitives-hub-doctor-1-2', workspaceRetained: false, durationMs: 42 };

const pass = (invariant: DiagnosticCheck['invariant'], item?: string): DiagnosticCheck =>
  ({ invariant, outcome: 'pass', ...(item === undefined ? {} : { item }) });
const fail = (invariant: DiagnosticCheck['invariant'], observed: DiagnosticCheck['observed'], item?: string): DiagnosticCheck =>
  ({ invariant, outcome: 'fail', observed, ...(item === undefined ? {} : { item }) });
const na = (invariant: DiagnosticCheck['invariant']): DiagnosticCheck => ({ invariant, outcome: 'not-applicable' });

/** What be1d161 produces for these two bundles. */
const BUNDLES: BundleResult[] = [
  {
    id: 'aph-e2e-only-prompt',
    checks: [pass('I0'), pass('I1', 'prompts/hello-world.prompt.md'),
      fail('I2', { id: 'hello-world.prompt', kind: 'prompt', occurrences: 1 }, 'prompts/hello-world.prompt.md'), pass('I3')]
  },
  {
    id: 'aph-e2e-only-chat-mode',
    checks: [pass('I0'), pass('I1', 'chat-modes/review.chatmode.md'),
      fail('I2', { id: 'review.chatmode', kind: 'chat-mode', occurrences: 1 }, 'chat-modes/review.chatmode.md'), pass('I3')]
  }
];

const caseResult = (c: PlannedCase): CaseResult => {
  const copilotRepo = c.target === 'copilot-cli' && c.scope === 'repository';
  const chatOnCopilot = c.kinds[0] === 'chat-mode' && c.target === 'copilot-cli';
  const effectiveScope = c.target === 'copilot-cli' ? 'user' : c.scope;
  return {
    id: c.id,
    effectiveScope,
    status: chatOnCopilot ? 'rejected' : 'installed',
    checks: [
      chatOnCopilot ? fail('I4', { status: 'rejected', errorCode: 'BUNDLE.UNSUPPORTED_CONTENT' }) : pass('I4'),
      chatOnCopilot ? na('I6') : pass('I6'),
      chatOnCopilot ? pass('I7') : na('I7'),
      copilotRepo ? fail('I8', { effectiveScope: 'user' }) : pass('I8'),
      chatOnCopilot ? na('I13') : pass('I13')
    ],
    destinations: chatOnCopilot ? [] : [`$HOME/.copilot/x/${c.id}`],
    durationMs: 5
  };
};

const shuffled = <T>(items: readonly T[]): T[] => [...items].toReversed();

describe('assemblePrimitiveReport', () => {
  it('assembles a report in plan order whatever the completion order', () => {
    const report = assemblePrimitiveReport(plan, shuffled(BUNDLES), shuffled(plan.cases.map((c) => caseResult(c))), GAPS, meta);
    expect(report.bundles.map((b) => b.id)).toEqual(['aph-e2e-only-prompt', 'aph-e2e-only-chat-mode']);
    expect(report.cases.map((c) => c.id)).toEqual(plan.cases.map((c) => c.id));
    expect(report.filters).toEqual(plan.filters);
    expect(report.notCovered).toEqual({ kinds: [] });
    expect(report).toMatchObject({ workspace: meta.workspace, workspaceRetained: false, durationMs: 42 });
    expect(report.error).toBeUndefined();
  });

  it('classifies, rolls up and counts', () => {
    const report = assemblePrimitiveReport(plan, BUNDLES, plan.cases.map((c) => caseResult(c)), GAPS, meta);
    expect(report.bundles.map((b) => [b.id, b.kinds, b.outcome])).toEqual([
      ['aph-e2e-only-prompt', ['prompt'], 'known-gap'],
      ['aph-e2e-only-chat-mode', ['chat-mode'], 'known-gap']
    ]);
    const chatRepo = report.cases.find((c) => c.id === 'aph-e2e-only-chat-mode__copilot-cli__repository')!;
    expect(chatRepo).toMatchObject({
      bundle: 'aph-e2e-only-chat-mode',
      kinds: ['chat-mode'],
      target: 'copilot-cli',
      scope: 'repository',
      effectiveScope: 'user',
      status: 'rejected',
      expectedStatus: 'installed',
      outcome: 'known-gap',
      gapIds: ['G17', 'G18'],
      destinations: [],
      durationMs: 5
    });
    // Known gaps: prompt + chat-mode on copilot-cli/repository (G18), chat-mode on copilot-cli/user (G17).
    expect(report.summary).toEqual({ cases: 8, pass: 5, knownGap: 3, fail: 0, bundles: { bundles: 2, pass: 0, knownGap: 2, fail: 0 } });
    expect(report.knownGaps).toEqual([
      { key: 'G17/I4/chat-mode@copilot-cli', id: 'G17', invariant: 'I4', absorbed: 2 },
      { key: 'G18/I8/copilot-cli@repository', id: 'G18', invariant: 'I8', absorbed: 2 },
      { key: 'G15/I2/prompt', id: 'G15', invariant: 'I2', absorbed: 1 },
      { key: 'G15/I2/chat-mode', id: 'G15', invariant: 'I2', absorbed: 1 }
    ]);
    expect(report.unusedKnownGaps).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('fails the run and reports the unused entry when a gap no longer matches (AC5)', () => {
    const gaps: KnownGap[] = GAPS.filter((g) => g.key !== 'G17/I4/chat-mode@copilot-cli');
    const report = assemblePrimitiveReport(plan, BUNDLES, plan.cases.map((c) => caseResult(c)), gaps, meta);
    expect(report.cases.filter((c) => c.outcome === 'fail').map((c) => c.id))
      .toEqual(['aph-e2e-only-chat-mode__copilot-cli__user', 'aph-e2e-only-chat-mode__copilot-cli__repository']);
    expect(report.ok).toBe(false);

    const fixed = plan.cases.map((c) => caseResult(c)).map((r) => (r.id === 'aph-e2e-only-prompt__copilot-cli__repository'
      ? { ...r, effectiveScope: 'repository', checks: r.checks.map((c) => (c.invariant === 'I8' ? pass('I8') : c)) }
      : r));
    const withUnused = assemblePrimitiveReport(planPrimitiveDiagnostics({ kinds: ['prompt'], targets: ['copilot-cli'], scopes: ['repository'] }),
      BUNDLES.slice(0, 1), fixed.filter((r) => r.id === 'aph-e2e-only-prompt__copilot-cli__repository'), GAPS, meta);
    expect(withUnused.unusedKnownGaps).toEqual([{ key: 'G18/I8/copilot-cli@repository', id: 'G18', invariant: 'I8' }]);
    expect(withUnused.ok).toBe(true);
  });

  it('fills unfinished items with a HARNESS check on an internal error', () => {
    const error = { step: 'internal' as const, message: 'onProgress threw' };
    const report = assemblePrimitiveReport(plan, BUNDLES.slice(0, 1), plan.cases.slice(0, 2).map((c) => caseResult(c)), GAPS, { ...meta, error });
    expect(report.bundles).toHaveLength(2);
    expect(report.cases).toHaveLength(plan.cases.length);
    const harness = { invariant: 'HARNESS', outcome: 'fail', detail: 'not run: internal error' };
    expect(report.bundles[1]).toMatchObject({ id: 'aph-e2e-only-chat-mode', outcome: 'fail', checks: [harness] });
    expect(report.cases[2]).toMatchObject({ status: null, effectiveScope: null, destinations: [], outcome: 'fail', checks: [harness], durationMs: 0 });
    expect(report.error).toEqual(error);
    expect(report.ok).toBe(false);
  });

  it('reports no bundles and no cases for a setup error', () => {
    const error = { step: 'preflight' as const, message: 'found ai-primitives-hub.yml above the diagnostic workspace' };
    const report = assemblePrimitiveReport(plan, [], [], GAPS, { ...meta, error });
    expect(report).toMatchObject({ bundles: [], cases: [], knownGaps: [], unusedKnownGaps: [], ok: false, error });
    expect(report.summary).toEqual({ cases: 0, pass: 0, knownGap: 0, fail: 0, bundles: { bundles: 0, pass: 0, knownGap: 0, fail: 0 } });
  });

  it('keeps a NOT_EVALUATED cascade as fail without making the bundle gaps unused', () => {
    const cascade: BundleResult = {
      id: 'aph-e2e-only-prompt',
      checks: [fail('I0', { buildExit: 1 }), ...(['I1', 'I2', 'I3'] as const).map((invariant) => fail(invariant, NOT_EVALUATED))]
    };
    const stopped = plan.cases.filter((c) => c.bundle === 'aph-e2e-only-prompt').map((c): CaseResult => ({
      id: c.id, effectiveScope: null, status: null, checks: [fail('I0', NOT_EVALUATED)], destinations: [], durationMs: 0
    }));
    const promptOnly = planPrimitiveDiagnostics({ kinds: ['prompt'], targets: ['vscode', 'copilot-cli'] });
    const report = assemblePrimitiveReport(promptOnly, [cascade], stopped, GAPS, meta);
    expect(report.bundles[0].outcome).toBe('fail');
    expect(report.cases.every((c) => c.outcome === 'fail')).toBe(true);
    expect(report.unusedKnownGaps).toEqual([]);
    expect(report.ok).toBe(false);
  });
});
