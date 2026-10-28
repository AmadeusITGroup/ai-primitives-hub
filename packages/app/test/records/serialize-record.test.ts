/**
 * Tests for app/records/serialize-record.ts (canonical form, BR1.11).
 */
import {
  type InstallRecord,
  parseRecord,
  RECORD_SCHEMA_URL,
  RegistryError,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  canonicalizeRecord,
  serializeRecord,
} from '../../src/records/serialize-record';
import {
  fixtureText,
} from './record-test-utils';

const CHECKSUM = `sha256:${'a'.repeat(64)}`;

const buildRecord = (order: 'forward' | 'reverse'): InstallRecord => {
  const files = [
    { installedPath: '.github/prompts/b.md', checksum: CHECKSUM },
    { installedPath: '.github/prompts/a.md', checksum: CHECKSUM }
  ];
  const entry = { version: '1.0.0', sourceId: 's', sourceType: 'github', installedAt: '2026-10-24T10:00:00.000Z', files };
  const reversedEntry = { files: [...files].reverse(), installedAt: entry.installedAt, sourceType: 'github', sourceId: 's', version: '1.0.0' };
  const forward = {
    $schema: RECORD_SCHEMA_URL,
    version: '3.0.0',
    level: 'repository',
    generatedAt: '2026-10-24T10:00:00.000Z',
    generatedBy: 'ai-primitives-hub-cli@0.3.0',
    bundles: { zeta: { tools: { vscode: entry, kiro: entry } }, alpha: { tools: { kiro: entry } } },
    sources: { s: { type: 'github', url: 'https://github.com/acme/prompts' } }
  };
  const reverse = {
    sources: { s: { url: 'https://github.com/acme/prompts', type: 'github' } },
    bundles: { alpha: { tools: { kiro: reversedEntry } }, zeta: { tools: { kiro: reversedEntry, vscode: reversedEntry } } },
    generatedBy: 'ai-primitives-hub-cli@0.3.0',
    generatedAt: '2026-10-24T10:00:00.000Z',
    level: 'repository',
    version: '3.0.0',
    $schema: RECORD_SCHEMA_URL
  };
  return (order === 'forward' ? forward : reverse) as unknown as InstallRecord;
};

describe('serializeRecord', () => {
  it('gives identical bytes for the same content in a different insertion order', () => {
    expect(serializeRecord(buildRecord('forward'))).toBe(serializeRecord(buildRecord('reverse')));
  });

  it('sorts keys at every depth and files by installedPath, with two-space indentation and a trailing newline', () => {
    const text = serializeRecord(buildRecord('forward'));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.startsWith('{\n  "$schema": ')).toBe(true);
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
    expect(text.indexOf('"bundles"')).toBeLessThan(text.indexOf('"generatedAt"'));
    expect(text.indexOf('"kiro"', text.indexOf('"zeta"'))).toBeLessThan(text.indexOf('"vscode"'));
    expect(text.indexOf('prompts/a.md')).toBeLessThan(text.indexOf('prompts/b.md'));
    expect(text.indexOf('"checksum"')).toBeLessThan(text.indexOf('"installedPath"'));
  });

  it('sets $schema to the canonical URL', () => {
    const record = buildRecord('forward');
    (record as Record<string, unknown>).$schema = 'https://example.com/other.json';
    expect(JSON.parse(serializeRecord(record)).$schema).toBe(RECORD_SCHEMA_URL);
    delete (record as Record<string, unknown>).$schema;
    expect(serializeRecord(record).startsWith(`{\n  "$schema": "${RECORD_SCHEMA_URL}"`)).toBe(true);
  });

  it('keeps unknown fields and round-trips the valid fixture byte for byte', () => {
    const text = fixtureText('valid-3.0.0.json');
    const record = parseRecord(text) as unknown as InstallRecord;
    expect(serializeRecord(record)).toBe(text);
  });

  it('builds prototype-free objects at every depth and leaves the input unchanged', () => {
    const record = buildRecord('reverse');
    const before = JSON.stringify(record);
    const copy = canonicalizeRecord(record);
    expect(Object.getPrototypeOf(copy)).toBeNull();
    expect(Object.getPrototypeOf(copy.bundles)).toBeNull();
    expect(Object.getPrototypeOf(copy.bundles.zeta.tools.kiro)).toBeNull();
    expect(Object.getPrototypeOf(copy.bundles.zeta.tools.kiro.files[0])).toBeNull();
    expect(JSON.stringify(record)).toBe(before);
  });

  it('refuses a forbidden key held as an own property', () => {
    const record = buildRecord('forward');
    const bundles = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(bundles, '__proto__', { value: { tools: {} }, enumerable: true });
    (record as Record<string, unknown>).bundles = bundles;
    expect(() => serializeRecord(record)).toThrow(RegistryError);
    expect(({} as Record<string, unknown>).tools).toBeUndefined();
  });
});
