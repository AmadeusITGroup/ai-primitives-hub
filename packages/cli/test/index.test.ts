import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  run,
} from '../src/index';

describe('@ai-primitives-hub/cli barrel', () => {
  it('exports run (the main entry point bin/ai-primitives-hub.js calls)', () => {
    expect(typeof run).toBe('function');
  });
});
