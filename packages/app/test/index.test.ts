import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  APP_PACKAGE_READY,
} from '../src/index';

describe('@ai-primitives-hub/app placeholder', () => {
  it('resolves its @ai-primitives-hub/infra dependency and re-exports a truthy marker', () => {
    expect(APP_PACKAGE_READY).toBe(true);
  });
});
