import type {
  LogEvent,
} from '@ai-primitives-hub/core';
import {
  expect,
  it,
  vi,
} from 'vitest';
import {
  getDefaultHubs,
} from '../../src/hub/default-hubs';

vi.mock('../../src/config/default-hubs.json', () => ({
  default: { defaultHubs: [] }
}));

it('uses and reports the hardcoded defaults when the bundled configuration is empty', () => {
  const logs: LogEvent[] = [];

  const hubs = getDefaultHubs((event) => logs.push(event));

  expect(hubs.map((hub) => hub.name)).toEqual([
    'Amadeus',
    'Prompt Registry Community Hub'
  ]);
  expect(logs).toEqual([{
    level: 'warn',
    message: 'Bundled default-hubs.json is empty; loaded 2 hardcoded default hub(s).'
  }]);
});
