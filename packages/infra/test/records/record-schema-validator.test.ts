/**
 * Tests for infra/records/record-schema-validator.ts (schema gate, NFR1.1).
 */
import * as fs from 'node:fs';
import {
  join,
} from 'node:path';
import {
  parseRecord,
  RegistryError,
  type UnvalidatedRecord,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  RecordSchemaValidator,
} from '../../src/records/record-schema-validator';

const VALID_TEXT = fs.readFileSync(join(__dirname, 'fixtures', 'valid-3.0.0.json'), 'utf8');

/**
 * A fresh, parsed copy of the valid fixture, edited by `edit`.
 * @param edit - Change to apply to the parsed record.
 */
const recordWith = (edit: (record: any) => void = () => undefined): UnvalidatedRecord => {
  const record = parseRecord(VALID_TEXT, 'ai-primitives-hub.lock.json');
  edit(record);
  return record;
};

const malformedDetail = (record: UnvalidatedRecord): string => {
  try {
    new RecordSchemaValidator().validate(record, 'ai-primitives-hub.lock.json');
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe('RECORD.MALFORMED');
    expect((error as RegistryError).context?.file).toBe('ai-primitives-hub.lock.json');
    return String((error as RegistryError).context?.detail);
  }
  throw new Error('expected RECORD.MALFORMED');
};

describe('RecordSchemaValidator', () => {
  it('accepts a valid 3.0.0 record parsed into prototype-free objects and keeps unknown fields', () => {
    const record = recordWith();
    const validated = new RecordSchemaValidator().validate(record);
    expect(validated).toBe(record);
    expect(validated.bundles['acme-prompts'].tools.vscode.futureEntryField).toEqual({ kept: true });
  });

  it('accepts unknown tool and source type names matching the open pattern', () => {
    const record = recordWith((r) => {
      r.bundles['acme-prompts'].tools['future-tool'] = { ...r.bundles['acme-prompts'].tools.kiro, sourceType: 'future-source' };
    });
    expect(() => new RecordSchemaValidator().validate(record)).not.toThrow();
  });

  it('refuses a record without $schema', () => {
    expect(malformedDetail(recordWith((r) => {
      delete r.$schema;
    }))).toContain('$schema');
  });

  it('refuses a bad checksum', () => {
    expect(malformedDetail(recordWith((r) => {
      r.bundles['acme-prompts'].tools.kiro.files[0].checksum = 'sha256:ABC';
    }))).toContain('/bundles/acme-prompts/tools/kiro/files/0/checksum');
  });

  it('refuses a tool key outside the name pattern', () => {
    expect(malformedDetail(recordWith((r) => {
      r.bundles['acme-prompts'].tools.Bad_Tool = r.bundles['acme-prompts'].tools.kiro;
    }))).toContain('property name');
  });

  it('refuses a bundle with no tools', () => {
    expect(malformedDetail(recordWith((r) => {
      r.bundles['acme-prompts'].tools = {};
    }))).toContain('/bundles/acme-prompts/tools');
  });

  it('refuses a bad installedAt date and an unknown level', () => {
    const detail = malformedDetail(recordWith((r) => {
      r.bundles['acme-prompts'].tools.kiro.installedAt = 'yesterday';
      r.level = 'machine';
    }));
    expect(detail).toContain('installedAt');
    expect(detail).toContain('/level');
  });

  it('refuses a source without a url, and caps the listed errors', () => {
    const detail = malformedDetail(recordWith((r) => {
      delete r.sources['acme-github'].url;
      delete r.generatedBy;
      delete r.generatedAt;
      r.level = 'machine';
    }));
    expect(detail).toMatch(/\(and \d+ more\)$/);
  });

  it('never quotes values from the record in the detail', () => {
    const detail = malformedDetail(recordWith((r) => {
      r.bundles['acme-prompts'].tools.kiro.files[0].checksum = 'secret-looking-value';
    }));
    expect(detail).not.toContain('secret-looking-value');
  });
});
