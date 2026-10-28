/**
 * `explain` catalog tests for the install record `RECORD.*` codes (BR4.2):
 * every code the record code can raise has a documented entry, and the
 * `RECORD` namespace is recognized.
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

interface ExplainEnvelope {
  status: string;
  data: { code: string; namespace: string; summary: string; remediation: string; docsUrl: string | null };
}

const explain = (argv: string[]): ReturnType<typeof runCommand> =>
  runCommand(['explain', ...argv], { commandClasses: [ExplainCommand], context: { cwd: process.cwd() } });

describe('explain RECORD.* codes', () => {
  it('documents RECORD.MALFORMED with a summary and a remediation', async () => {
    const result = await explain(['RECORD.MALFORMED', '-o', 'json']);

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as ExplainEnvelope;
    expect(envelope.data).toMatchObject({ code: 'RECORD.MALFORMED', namespace: 'RECORD' });
    expect(envelope.data.summary).toContain('ai-primitives-hub.lock.json');
    expect(envelope.data.remediation).toMatch(/fix or remove/i);
  });

  it.each([...RECORD_ERROR_CODES])('has a catalog entry for %s', async (code) => {
    const result = await explain([code, '-o', 'json']);

    expect(result.exitCode).toBe(0);
    const { data } = JSON.parse(result.stdout) as ExplainEnvelope;
    expect(data.namespace).toBe('RECORD');
    expect(data.summary).not.toContain('has no catalog entry yet');
    expect(data.remediation.length).toBeGreaterThan(0);
  });

  it('renders a RECORD code in text output', async () => {
    const result = await explain(['RECORD.NEWER_FORMAT']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^RECORD\.NEWER_FORMAT\n/);
    expect(result.stdout).toContain('Remediation: Upgrade ai-primitives-hub');
  });

  it('gives the generic entry for an uncatalogued code in the RECORD namespace', async () => {
    const result = await explain(['RECORD.SOMETHING_NEW', '-o', 'json']);

    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as ExplainEnvelope).data.summary).toContain('has no catalog entry yet');
  });
});
