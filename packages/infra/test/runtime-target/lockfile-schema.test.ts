import {
  encodeLockfileV3,
  LOCKFILE_SCHEMA,
  LOCKFILE_V3_SCHEMA_ID,
  runtimeReceiptId,
} from '@ai-primitives-hub/core';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  describe,
  expect,
  it,
} from 'vitest';

const validator = () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(LOCKFILE_SCHEMA);
};

describe('lockfile.schema.json', () => {
  it('is published under the lockfile URL and accepts an encoded v3 document', () => {
    expect(LOCKFILE_SCHEMA.$id).toBe(LOCKFILE_V3_SCHEMA_ID);
    const root = '/home/u/.kiro/steering';
    const receiptId = runtimeReceiptId('kiro', 'user', root, 'src', 'alpha');
    const doc = encodeLockfileV3({
      receipts: {
        [receiptId]: {
          receiptId,
          instance: { type: 'kiro', scope: 'user', root },
          collection: { sourceId: 'src', manifestId: 'alpha' },
          payloadId: 'a'.repeat(64),
          version: '1.0.0',
          outputs: { [`${root}/alpha.prompt.md`]: { sha256: `sha256:${'b'.repeat(64)}` } },
          installedAt: '2026-01-01T00:00:00.000Z',
          source: { type: 'local', url: '/abs/dir' }
        }
      }
    }, 'ai-primitives-hub@1.0.0');
    const validate = validator();
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a v3 document carrying payload bytes or extra sections', () => {
    const validate = validator();
    expect(validate({
      $schema: LOCKFILE_V3_SCHEMA_ID, version: '3.0.0', generatedAt: '2026-01-01T00:00:00.000Z',
      generatedBy: 'x', sources: {}, bundles: {}, payloads: {}
    })).toBe(false);
  });

  it('describes v3 only: a v2 document is rejected', () => {
    const validate = validator();
    expect(validate({
      $schema: 'x', version: '2.0.0', generatedAt: '2026-01-01T00:00:00.000Z', generatedBy: 'x', bundles: {}, sources: {}
    })).toBe(false);
  });

  it('accepts repository-relative instance roots without context or commit mode', () => {
    const root = '/work/repo/.kiro';
    const receiptId = runtimeReceiptId('kiro', 'repository', root, 'src', 'alpha', '/work/repo');
    const doc = encodeLockfileV3({
      receipts: {
        [receiptId]: {
          receiptId,
          instance: { type: 'kiro', scope: 'repository', root },
          collection: { sourceId: 'src', manifestId: 'alpha' },
          payloadId: 'a'.repeat(64),
          version: '1.0.0',
          outputs: { [`${root}/steering/alpha.prompt.md`]: { sha256: `sha256:${'b'.repeat(64)}` } },
          installedAt: '2026-01-01T00:00:00.000Z',
          contextRoot: '/work/repo'
        }
      }
    }, 'g');
    const validate = validator();
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify(doc)).not.toContain('/work/repo');
  });
});
