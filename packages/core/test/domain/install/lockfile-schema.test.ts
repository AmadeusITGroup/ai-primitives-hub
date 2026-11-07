/**
 * Structural checks of the published lockfile schema (core has no JSON
 * Schema validator; the extension and CLI validate against this file).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import lockfileSchema from '../../../src/public/schemas/lockfile.schema.json';

interface PropertySchema {
  type?: string;
  minLength?: number;
  pattern?: string;
  enum?: string[];
  description?: string;
  examples?: string[];
}

interface EntrySchema {
  required: string[];
  properties: Record<string, PropertySchema>;
  additionalProperties: boolean;
}

const definitions = (lockfileSchema as unknown as { definitions: Record<string, EntrySchema> }).definitions;
const bundleEntry = definitions.bundleEntry;
const fileEntry = definitions.fileEntry;

describe('lockfile schema', () => {
  it('accepts an optional targetType on bundle entries', () => {
    expect(bundleEntry.properties.targetType).toMatchObject({ type: 'string', minLength: 1 });
    expect(bundleEntry.required).not.toContain('targetType');
  });

  it('accepts an optional sha256 installedChecksum on file entries', () => {
    expect(fileEntry.properties.installedChecksum).toMatchObject({ type: 'string', pattern: '^[a-f0-9]{64}$' });
    expect(fileEntry.required).not.toContain('installedChecksum');
    const pattern = new RegExp(fileEntry.properties.installedChecksum.pattern ?? '');
    expect(pattern.test('a'.repeat(64))).toBe(true);
    expect(pattern.test('A'.repeat(64))).toBe(false);
    expect(pattern.test('a'.repeat(63))).toBe(false);
  });

  it('still accepts the deprecated commitMode on bundle entries', () => {
    expect(bundleEntry.properties.commitMode?.enum).toEqual(['commit', 'local-only']);
    expect(bundleEntry.additionalProperties).toBe(false);
  });

  it('describes file paths as bundle-relative', () => {
    expect(fileEntry.properties.path.description).toContain('Bundle-relative');
    expect(fileEntry.properties.path.examples?.every((example) => !example.startsWith('.github/'))).toBe(true);
  });
});
