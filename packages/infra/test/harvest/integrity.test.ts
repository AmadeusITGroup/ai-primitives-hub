import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  computeIndexHmac,
  type IntegritySecret,
  saveIndexWithIntegrity,
  verifyIndexIntegrity,
} from '../../src/harvest/integrity';
import {
  createTempDir,
} from '../helpers/temp-dir';

let tmp: string;
let cleanup: () => void;
beforeEach(() => {
  [tmp, cleanup] = createTempDir('pi-integ-');
});
afterEach(() => {
  cleanup();
});

const secret: IntegritySecret = { keyId: 'test', key: 'a-test-secret' };

describe('integrity', () => {
  it('computeIndexHmac is deterministic for the same payload', () => {
    const a = computeIndexHmac({ anything: 'works' }, secret);
    const b = computeIndexHmac({ anything: 'works' }, secret);
    expect(a).toBe(b);
    expect(/^[a-f0-9]{64}$/i.test(a)).toBe(true);
  });

  it('different keys yield different HMACs', () => {
    const a = computeIndexHmac({ x: 1 }, { keyId: 'k', key: 'secret-1' });
    const b = computeIndexHmac({ x: 1 }, { keyId: 'k', key: 'secret-2' });
    expect(a).not.toBe(b);
  });

  it('save then verify round-trips cleanly', () => {
    const file = path.join(tmp, 'idx.json');
    saveIndexWithIntegrity({ hello: 'world' }, file, secret);
    verifyIndexIntegrity(file, secret); // no throw
  });

  it('detects a tampered payload', () => {
    const file = path.join(tmp, 'idx.json');
    saveIndexWithIntegrity({ hello: 'world' }, file, secret);
    const raw = fs.readFileSync(file, 'utf8');
    const patched = raw.replace('"world"', '"earth"');
    fs.writeFileSync(file, patched, 'utf8');
    expect(() => verifyIndexIntegrity(file, secret)).toThrow(/hmac mismatch/i);
  });

  it('detects a wrong secret (different keyId)', () => {
    const file = path.join(tmp, 'idx.json');
    saveIndexWithIntegrity({ hello: 'world' }, file, secret);
    expect(() => verifyIndexIntegrity(file, { keyId: 'other', key: 'other-secret' })).toThrow(/unknown keyId|hmac mismatch/i);
  });

  it('throws with a clear error when the envelope is missing its sig block', () => {
    const file = path.join(tmp, 'idx.json');
    fs.writeFileSync(file, JSON.stringify({ payload: { a: 1 } }), 'utf8');
    expect(() => verifyIndexIntegrity(file, secret)).toThrow(/missing signature/i);
  });
});
