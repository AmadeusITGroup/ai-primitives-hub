/**
 * `explain` catalog contract for the install record `RECORD.*` codes (BR4.2).
 */
import {
  RECORD_ERROR_CODES,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  ExplainCommand,
} from '../../src/commands/explain';
import {
  runCommand,
} from '../../src/framework';

describe('explain RECORD.* codes', () => {
  it.each([...RECORD_ERROR_CODES])('has a catalog entry for %s', async (code) => {
    const result = await runCommand(['explain', code, '-o', 'json'], { commandClasses: [ExplainCommand], context: { cwd: process.cwd() } });

    expect(result.exitCode).toBe(0);
    const { data } = JSON.parse(result.stdout) as { data: { namespace: string; summary: string; remediation: string } };
    expect(data.namespace).toBe('RECORD');
    expect(data.summary).not.toContain('has no catalog entry yet');
    expect(data.remediation.length).toBeGreaterThan(0);
  });
});
