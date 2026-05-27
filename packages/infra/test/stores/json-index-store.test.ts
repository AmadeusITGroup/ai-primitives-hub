import * as syncFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  PrimitiveIndex,
} from '../../src/search/primitive-index';
import {
  loadIndex,
  saveIndex,
  tryLoadIndex,
} from '../../src/stores/json-index-store';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prc-json-index-store-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('json-index-store', () => {
  it('saves and loads index', () => {
    const idx = new PrimitiveIndex();
    const filePath = path.join(tmp, 'index.json');
    saveIndex(idx, filePath);
    expect(syncFs.existsSync(filePath)).toBe(true);
    const loaded = loadIndex(filePath);
    expect(loaded).toBeDefined();
  });

  it('creates parent directories when saving', () => {
    const idx = new PrimitiveIndex();
    const filePath = path.join(tmp, 'nested', 'dir', 'index.json');
    saveIndex(idx, filePath);
    expect(syncFs.existsSync(filePath)).toBe(true);
  });

  it('throws when loading missing file', () => {
    const filePath = path.join(tmp, 'missing.json');
    expect(() => loadIndex(filePath)).toThrow();
  });

  it('tryLoadIndex returns null for missing file', () => {
    const filePath = path.join(tmp, 'missing.json');
    const result = tryLoadIndex(filePath);
    expect(result).toBeNull();
  });

  it('tryLoadIndex returns null for invalid JSON', async () => {
    const filePath = path.join(tmp, 'invalid.json');
    await fs.writeFile(filePath, 'invalid json');
    const result = tryLoadIndex(filePath);
    expect(result).toBeNull();
  });

  it('tryLoadIndex returns index for valid file', () => {
    const idx = new PrimitiveIndex();
    const filePath = path.join(tmp, 'index.json');
    saveIndex(idx, filePath);
    const result = tryLoadIndex(filePath);
    expect(result).not.toBeNull();
  });
});
