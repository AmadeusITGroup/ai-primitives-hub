/**
 * Index integrity via HMAC-SHA256.
 *
 * Scope: detect accidental bit-rot and casual tampering with
 * `primitive-index.json` on disk. It is *not* a replacement for filesystem
 * permissions or an adversary with access to the signing key. The key is
 * only as private as the place it's stored (env var on a dev box, a
 * secret in a shared cache).
 *
 * Envelope:
 *   {
 *     payload: { ... the actual index ... },
 *     sig: {
 *       alg: 'HMAC-SHA256',
 *       keyId: '<caller-provided>',
 *       hmac: '<hex>'
 *     }
 *   }
 *
 * The canonical bytes used for the HMAC are `JSON.stringify(payload)` —
 * a stable JSON representation is not required because we HMAC over the
 * exact bytes we also write to disk.
 */

import {
  createHmac,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface IntegritySecret {
  keyId: string;
  key: string;
}

/**
 * Hex-encoded HMAC-SHA256 of the canonical JSON of `payload` under `secret.key`.
 * @param payload - The object to sign.
 * @param secret - HMAC secret (keyId + key).
 */
export function computeIndexHmac(payload: unknown, secret: IntegritySecret): string {
  const bytes = canonicalBytes(payload);
  return createHmac('sha256', secret.key).update(bytes).digest('hex');
}

export interface IntegrityEnvelope {
  payload: unknown;
  sig: {
    alg: 'HMAC-SHA256';
    keyId: string;
    hmac: string;
  };
}

/**
 * Atomically write `payload` to `file` wrapped in an HMAC envelope.
 * @param payload - The JSON-serialisable content to sign and store.
 * @param file - Absolute destination path.
 * @param secret - HMAC secret used to produce the signature.
 */
export function saveIndexWithIntegrity(
  payload: unknown,
  file: string,
  secret: IntegritySecret
): void {
  const hmac = computeIndexHmac(payload, secret);
  const envelope: IntegrityEnvelope = {
    payload,
    sig: { alg: 'HMAC-SHA256', keyId: secret.keyId, hmac }
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(envelope), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Read `file`, verify its HMAC, and return the parsed payload. Throws
 * when the envelope is missing, the keyId doesn't match, or the content
 * has been tampered with.
 * @param file - Absolute path of the envelope JSON file.
 * @param secret - HMAC secret used to verify.
 */
export function verifyIndexIntegrity(file: string, secret: IntegritySecret): unknown {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as Partial<IntegrityEnvelope>;
  if (!parsed?.sig || typeof parsed.sig !== 'object') {
    throw new Error(`${file}: missing signature envelope`);
  }
  if (parsed.sig.keyId !== secret.keyId) {
    throw new Error(`${file}: unknown keyId ${parsed.sig.keyId}; expected ${secret.keyId}`);
  }
  const computed = createHmac('sha256', secret.key)
    .update(canonicalBytes(parsed.payload))
    .digest('hex');
  if (computed !== parsed.sig.hmac) {
    throw new Error(`${file}: hmac mismatch — content has been modified`);
  }
  return parsed.payload;
}

function canonicalBytes(payload: unknown): Buffer {
  // We don't need a stable-key sort here because:
  //   - we only verify against the exact bytes we wrote, and
  //   - the JS engine preserves insertion order for plain objects.
  return Buffer.from(JSON.stringify(payload), 'utf8');
}
