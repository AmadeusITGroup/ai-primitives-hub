import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  INFRA_PACKAGE_READY,
} from '../src/index';

describe('@ai-primitives-hub/infra placeholder', () => {
  it('resolves its @ai-primitives-hub/core dependency and re-exports a truthy marker', () => {
    expect(INFRA_PACKAGE_READY).toBe(true);
  });
});
