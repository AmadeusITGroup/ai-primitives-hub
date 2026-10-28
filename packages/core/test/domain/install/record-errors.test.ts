/**
 * RECORD.* error helper (C6, BR4.2).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  isRecordError,
  RECORD_ERROR_CODES,
  recordError,
} from '../../../src/domain/install/record-errors';
import {
  RegistryError,
} from '../../../src/domain/registry-error';

describe('recordError', () => {
  it.each(RECORD_ERROR_CODES.map((code) => [code]))('builds a RegistryError for %s with a default message and hint', (code) => {
    const error = recordError(code);
    expect(error).toBeInstanceOf(RegistryError);
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.hint?.length).toBeGreaterThan(0);
    expect(error.context).toBeUndefined();
  });

  it('carries the file and detail in context so they reach JSON output', () => {
    const error = recordError('RECORD.MALFORMED', { file: 'ai-primitives-hub.lock.json', detail: 'not valid JSON' });
    expect(error.context).toEqual({ file: 'ai-primitives-hub.lock.json', detail: 'not valid JSON' });
    expect(error.toJSON()).toMatchObject({
      code: 'RECORD.MALFORMED',
      context: { file: 'ai-primitives-hub.lock.json', detail: 'not valid JSON' }
    });
  });

  it('lets the caller override the message and hint and add context fields', () => {
    const cause = new Error('EACCES');
    const error = recordError('RECORD.CLI_MANAGED', {
      message: '"acme" was installed with the ai-primitives-hub CLI.',
      hint: 'Run "ai-primitives-hub install acme" again.',
      context: { bundleId: 'acme', action: 'update' },
      cause
    });
    expect(error.message).toBe('"acme" was installed with the ai-primitives-hub CLI.');
    expect(error.hint).toBe('Run "ai-primitives-hub install acme" again.');
    expect(error.context).toEqual({ bundleId: 'acme', action: 'update' });
    expect(error.cause).toBe(cause);
  });

  it('accepts RECORD as an error namespace in RegistryError', () => {
    expect(new RegistryError({ code: 'RECORD.SOMETHING_NEW', message: 'm' }).code).toBe('RECORD.SOMETHING_NEW');
  });
});

describe('isRecordError', () => {
  it('matches any RECORD.* code when no code is given', () => {
    expect(isRecordError(recordError('RECORD.WRITE_FAILED'))).toBe(true);
  });

  it('matches only the given code', () => {
    const error = recordError('RECORD.NEWER_FORMAT');
    expect(isRecordError(error, 'RECORD.NEWER_FORMAT')).toBe(true);
    expect(isRecordError(error, 'RECORD.MALFORMED')).toBe(false);
  });

  it('rejects other errors', () => {
    expect(isRecordError(new RegistryError({ code: 'FS.NOT_FOUND', message: 'm' }))).toBe(false);
    expect(isRecordError(new Error('RECORD.MALFORMED'))).toBe(false);
    expect(isRecordError(undefined)).toBe(false);
  });
});
