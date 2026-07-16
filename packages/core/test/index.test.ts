import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  CORE_PACKAGE_READY,
} from '../src/index';

describe('@ai-primitives-hub/core placeholder', () => {
  it('exports a truthy readiness marker', () => {
    expect(CORE_PACKAGE_READY).toBe(true);
  });
});
