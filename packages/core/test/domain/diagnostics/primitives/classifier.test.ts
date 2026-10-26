/**
 * Tests for the primitive diagnostics classifier.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  type ClassifiedCheck,
  classifyBundle,
  classifyCase,
  classifyCheck,
  type DiagnosticBundle,
  type DiagnosticCheck,
  findUnusedKnownGaps,
  type KnownGap,
  NOT_EVALUATED,
  type PlannedCase,
  planPrimitiveDiagnostics,
  PRIMITIVE_DIAGNOSTIC_BUNDLES,
  PRIMITIVE_KNOWN_GAPS,
  rollup,
} from '../../../../src/domain/diagnostics/primitives';
import type {
  TargetType,
} from '../../../../src/domain/install/target';
import type {
  PrimitiveKind,
} from '../../../../src/domain/primitive/types';

const plan = planPrimitiveDiagnostics({});
const caseOf = (kind: PrimitiveKind, target: TargetType, scope: 'user' | 'repository'): PlannedCase =>
  plan.cases.find((c) => c.id === `aph-e2e-only-${kind}__${target}__${scope}`)!;
const bundleOf = (kind: PrimitiveKind): DiagnosticBundle => PRIMITIVE_DIAGNOSTIC_BUNDLES.find((b) => b.items[0].kind === kind)!;

const pass = (invariant: DiagnosticCheck['invariant']): DiagnosticCheck => ({ invariant, outcome: 'pass' });
const failed = (invariant: DiagnosticCheck['invariant'], observed: DiagnosticCheck['observed'], item?: string): DiagnosticCheck =>
  ({ invariant, outcome: 'fail', observed, ...(item === undefined ? {} : { item }), detail: 'x' });
const rejected = { status: 'rejected', errorCode: 'BUNDLE.UNSUPPORTED_CONTENT' };
const passingCase = (): DiagnosticCheck[] => [pass('I4'), pass('I6'), { invariant: 'I7', outcome: 'not-applicable' }, pass('I8'), pass('I13')];

describe('classifyCheck', () => {
  it('leaves passing and non-matching checks unchanged', () => {
    expect(classifyCheck(pass('I4'), { kinds: ['prompt'], target: 'vscode', scope: 'user' }))
      .toEqual({ check: pass('I4'), absorbedBy: [], subject: { kinds: ['prompt'], target: 'vscode', scope: 'user' } });
  });

  it('compares observed by exact deep equality with arrays sorted', () => {
    const gap: KnownGap = { key: 'test-gap/I1/x', id: 'test-gap', invariant: 'I1', match: {}, observed: { missingArchivePaths: ['b', 'a'] }, summary: 's' };
    const result = classifyCheck(failed('I1', { missingArchivePaths: ['a', 'b'] }), { kinds: ['power'] }, [gap]);
    expect(result.check).toMatchObject({ outcome: 'known-gap', gapIds: ['test-gap'] });
    expect(result.absorbedBy).toEqual(['test-gap/I1/x']);
    expect(classifyCheck(failed('I1', { missingArchivePaths: ['a'] }), { kinds: ['power'] }, [gap]).check.outcome).toBe('fail');
  });

  it('never absorbs a HARNESS check', () => {
    const gap: KnownGap = { key: 'test-gap/HARNESS/x', id: 'test-gap', invariant: 'HARNESS', match: {}, observed: null, summary: 's' };
    expect(classifyCheck(failed('HARNESS', null), { kinds: ['prompt'] }, [gap]).check.outcome).toBe('fail');
  });

  it('matches a bundles selector on the subject bundle only', () => {
    const gap: KnownGap = { key: 'test-gap/I4/mix', id: 'test-gap', invariant: 'I4', match: { bundles: ['mix'] }, observed: rejected, summary: 's' };
    expect(classifyCheck(failed('I4', rejected), { kinds: ['prompt'], bundle: 'mix', target: 'vscode' }, [gap]).check.outcome).toBe('known-gap');
    expect(classifyCheck(failed('I4', rejected), { kinds: ['prompt'], bundle: 'other', target: 'vscode' }, [gap]).check.outcome).toBe('fail');
    expect(classifyCheck(failed('I4', rejected), { kinds: ['prompt'], target: 'vscode' }, [gap]).check.outcome).toBe('fail');
  });

  it('never matches a selector on a dimension the subject lacks', () => {
    const gap: KnownGap = {
      key: 'manifest-id-file-stem/I2/prompt@vscode', id: 'manifest-id-file-stem', invariant: 'I2', match: { kinds: ['prompt'], targets: ['vscode'] },
      observed: { id: 'hello-world.prompt', kind: 'prompt', occurrences: 1 }, summary: 's'
    };
    const check = failed('I2', { id: 'hello-world.prompt', kind: 'prompt', occurrences: 1 }, 'prompts/hello-world.prompt.md');
    expect(classifyCheck(check, { kinds: ['prompt'] }, [gap]).check.outcome).toBe('fail');
  });
});

describe('classifyCase', () => {
  it('passes a clean case', () => {
    expect(classifyCase(caseOf('prompt', 'vscode', 'user'), passingCase())).toMatchObject({ outcome: 'pass', gapIds: [] });
  });

  it('absorbs chat-mode on copilot-cli at repository scope with copilot-cli-repository-scope only', () => {
    const checks = [pass('I4'), pass('I6'), { invariant: 'I7', outcome: 'not-applicable' } as DiagnosticCheck,
      failed('I8', { effectiveScope: 'user' }), pass('I13')];
    const result = classifyCase(caseOf('chat-mode', 'copilot-cli', 'repository'), checks);
    expect(result.outcome).toBe('known-gap');
    expect(result.gapIds).toEqual(['copilot-cli-repository-scope']);
    expect(result.checks.map((c) => [c.invariant, c.outcome, c.gapIds])).toEqual([
      ['I4', 'pass', undefined],
      ['I6', 'pass', undefined],
      ['I7', 'not-applicable', undefined],
      ['I8', 'known-gap', ['copilot-cli-repository-scope']],
      ['I13', 'pass', undefined]
    ]);
  });
  it('fails a chat-mode rejection on copilot-cli now that chat-mode-rejected is fixed (#526)', () => {
    const checks = [failed('I4', rejected), { invariant: 'I6', outcome: 'not-applicable' } as DiagnosticCheck,
      pass('I7'), pass('I8'), { invariant: 'I13', outcome: 'not-applicable' } as DiagnosticCheck];
    const result = classifyCase(caseOf('chat-mode', 'copilot-cli', 'user'), checks);
    expect(result.outcome).toBe('fail');
    expect(result.checks[0]).toMatchObject({ outcome: 'fail' });
    expect(result.checks[0].gapIds).toBeUndefined();
  });
  it('classifies a per-item case check by its item kind and the case bundle', () => {
    const mix: PlannedCase = {
      id: 'mix__vscode__user',
      bundle: 'mix',
      kinds: ['prompt', 'mcp-server'],
      items: [{ path: 'prompts/hello-world.prompt.md', kind: 'prompt' }, { path: 'mcp-servers/github.mcp.json', kind: 'mcp-server' }],
      target: 'vscode',
      scope: 'user',
      expectedStatus: 'installed'
    };
    const promptGap: KnownGap = { key: 'test-gap/I9/prompt', id: 'test-gap', invariant: 'I9', match: { kinds: ['prompt'] }, observed: { rejected: true }, summary: 's' };
    const bundleGap: KnownGap = { key: 'mix-gap/I9/mix', id: 'mix-gap', invariant: 'I9', match: { bundles: ['mix'] }, observed: { rejected: true }, summary: 's' };
    const result = classifyCase(mix, [
      failed('I9', { rejected: true }, 'mcp-servers/github.mcp.json'),
      failed('I9', { rejected: true }, 'prompts/hello-world.prompt.md')
    ], [promptGap, bundleGap]);
    expect(result.records.map((r) => [r.subject, r.absorbedBy])).toEqual([
      [{ kinds: ['mcp-server'], bundle: 'mix', target: 'vscode', scope: 'user' }, ['mix-gap/I9/mix']],
      [{ kinds: ['prompt'], bundle: 'mix', target: 'vscode', scope: 'user' }, ['test-gap/I9/prompt', 'mix-gap/I9/mix']]
    ]);
  });

  it('keeps a different failure mode as fail (mcp-server-rejected with status error)', () => {
    const checks = [failed('I4', { status: 'error', errorCode: 'INTERNAL.UNEXPECTED' }), ...passingCase().slice(1)];
    const result = classifyCase(caseOf('mcp-server', 'vscode', 'user'), checks);
    expect(result.outcome).toBe('fail');
    expect(result.checks[0]).toMatchObject({ outcome: 'fail' });
    expect(result.checks[0].gapIds).toBeUndefined();
  });
});

describe('classifyBundle', () => {
  it('keeps a different wrong id as fail (manifest-id-file-stem prompt)', () => {
    const prompt = bundleOf('prompt');
    const checks = [pass('I0'), { ...pass('I1'), item: prompt.items[0].path },
      failed('I2', { id: 'hello', kind: 'prompt', occurrences: 1 }, prompt.items[0].path), pass('I3')];
    expect(classifyBundle(prompt, checks).outcome).toBe('fail');
  });

  it('absorbs the power-directory-unit power checks per item', () => {
    const power = bundleOf('power');
    const checks = [pass('I0'),
      failed('I1', { missingArchivePaths: ['powers/stripe/steering/payments.md'] }, power.items[0].path),
      failed('I2', { id: 'POWER', kind: 'power', occurrences: 1 }, power.items[0].path), pass('I3')];
    const result = classifyBundle(power, checks);
    expect(result).toMatchObject({ outcome: 'known-gap', gapIds: ['power-directory-unit'] });
    expect(result.records.flatMap((r) => r.absorbedBy)).toEqual(['power-directory-unit/I1/power', 'power-directory-unit/I2/power']);
  });

  it('never absorbs a NOT_EVALUATED cascade', () => {
    const power = bundleOf('power');
    const checks: DiagnosticCheck[] = [failed('I0', { buildExit: 1 }),
      ...(['I1', 'I2', 'I3'] as const).map((invariant): DiagnosticCheck => ({ invariant, outcome: 'fail', observed: NOT_EVALUATED }))];
    const result = classifyBundle(power, checks);
    expect(result.outcome).toBe('fail');
    expect(result.checks.every((c) => c.outcome === 'fail')).toBe(true);
    expect(findUnusedKnownGaps(result.records).map((g) => g.key)).toEqual([]);
  });
});

describe('findUnusedKnownGaps', () => {
  const records = (...lists: { records: readonly ClassifiedCheck[] }[]): ClassifiedCheck[] => lists.flatMap((l) => [...l.records]);

  it('reports an entry whose targeted check passed', () => {
    const prompt = bundleOf('prompt');
    const fixed = classifyBundle(prompt, [pass('I0'), { ...pass('I1'), item: prompt.items[0].path }, { ...pass('I2'), item: prompt.items[0].path }, pass('I3')]);
    expect(findUnusedKnownGaps(records(fixed)).map((g) => g.key)).toEqual(['manifest-id-file-stem/I2/prompt']);
  });

  it('reports an entry whose targeted check fails differently', () => {
    const different = classifyCase(caseOf('hook', 'kiro', 'user'), [failed('I4', { status: 'error', errorCode: 'X' }), ...passingCase().slice(1)]);
    expect(findUnusedKnownGaps(records(different)).map((g) => g.key)).toEqual(['kiro-hook-rejected/I4/hook@kiro']);
  });

  it('does not report entries outside the run filters', () => {
    const clean = classifyCase(caseOf('prompt', 'vscode', 'user'), passingCase());
    expect(findUnusedKnownGaps(records(clean))).toEqual([]);
  });

  it('does not report an entry that absorbed something', () => {
    const gap = classifyCase(caseOf('hook', 'kiro', 'user'), [failed('I4', rejected), ...passingCase().slice(1)]);
    const fixedElsewhere = classifyCase(caseOf('hook', 'kiro', 'repository'), passingCase());
    expect(findUnusedKnownGaps(records(gap, fixedElsewhere))).toEqual([]);
  });

  it('defaults to PRIMITIVE_KNOWN_GAPS and returns unused entries in declaration order', () => {
    const allPass = plan.cases.filter((c) => c.target === 'kiro' || c.target === 'copilot-cli')
      .map((c) => classifyCase(c, [{ ...pass('I4') }, pass('I6'), pass('I7'), pass('I8'), pass('I13')]));
    const unused = findUnusedKnownGaps(records(...allPass)).map((g) => g.key);
    expect(unused).toEqual(PRIMITIVE_KNOWN_GAPS.filter((g) => ['I4', 'I8'].includes(g.invariant)).map((g) => g.key));
  });
});

describe('rollup', () => {
  it('ranks fail > known-gap > pass and ignores not-applicable', () => {
    const na: DiagnosticCheck = { invariant: 'I7', outcome: 'not-applicable' };
    const gap: DiagnosticCheck = { invariant: 'I4', outcome: 'known-gap' };
    expect(rollup([])).toBe('pass');
    expect(rollup([na])).toBe('pass');
    expect(rollup([pass('I4'), na])).toBe('pass');
    expect(rollup([pass('I4'), gap])).toBe('known-gap');
    expect(rollup([gap, failed('I8', null), pass('I4')])).toBe('fail');
  });
});
