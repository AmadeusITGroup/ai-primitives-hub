/**
 * The primitive diagnostics case model and its driver port are part of the
 * public `@ai-primitives-hub/core` surface.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import * as core from '../../../../src/index';

describe('@ai-primitives-hub/core primitive diagnostics exports', () => {
  it('exports the planner, the known gaps, the evaluators and the report assembly', () => {
    expect(typeof core.planPrimitiveDiagnostics).toBe('function');
    expect(core.PRIMITIVE_KNOWN_GAPS).toHaveLength(13);
    expect(typeof core.evaluateBundle).toBe('function');
    expect(typeof core.evaluateCase).toBe('function');
    expect(typeof core.classifyCase).toBe('function');
    expect(typeof core.assemblePrimitiveReport).toBe('function');
    expect(typeof core.checkSandboxContainment).toBe('function');
    expect(core.planPrimitiveDiagnostics({}).cases).toHaveLength(352);
  });
});
