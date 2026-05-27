/**
 * Minimal in-memory zip writer (STORE method only — no compression).
 *
 * Used by source resolvers that synthesize bundles on the fly
 * (awesome-copilot, skills) instead of downloading pre-packaged
 * archives. STORE mode is sufficient for the small text payloads
 * these bundles carry; decoded by `yauzl` like any other zip.
 *
 * Implements ZIP file format spec (PKWARE APPNOTE.TXT v6.3.4)
 * sufficient for: ASCII filenames, UTF-8 contents, files <4 GiB.
 * @module install/zip-writer
 */
import {
  createHash,
} from 'node:crypto';
import {
  deflateRawSync,
} from 'node:zlib';

interface ZipEntry {
  /** Forward-slash relative path inside the archive. */
  path: string;
  /** Entry contents. */
  bytes: Uint8Array;
}

/**
 * Build a zip archive containing the given entries. STORE method.
 * @param entries Files to include (path forward-slash separated).
 * @returns Complete .zip bytes ready to write to disk.
 */
export const buildZip = (entries: readonly ZipEntry[]): Uint8Array => {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;
  const records: { local: Buffer; central: Buffer }[] = [];
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const data = Buffer.from(entry.bytes);
    const crc32 = computeCrc32(data);
    const size = data.length;
    // Use deflate when it shrinks the data; otherwise STORE.
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.length < size;
    const compressedBytes = useDeflate ? deflated : data;
    const compressedSize = compressedBytes.length;
    const method = useDeflate ? 8 : 0;
    // --- Local file header ---
    const local = Buffer.alloc(30 + nameBytes.length + compressedSize);
    local.writeUInt32LE(0x04_03_4B_50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x08_00, 6); // flags: bit 11 = UTF-8
    local.writeUInt16LE(method, 8); // compression method
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc32, 14); // crc32
    local.writeUInt32LE(compressedSize, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26); // filename length
    local.writeUInt16LE(0, 28); // extra length
    nameBytes.copy(local, 30);
    compressedBytes.copy(local, 30 + nameBytes.length);
    // --- Central directory entry ---
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02_01_4B_50, 0); // signature
    central.writeUInt16LE(0x03_1E, 4); // version made by (Unix, v3.0)
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x08_00, 8); // flags
    central.writeUInt16LE(method, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc32, 16); // crc32
    central.writeUInt32LE(compressedSize, 20); // compressed size
    central.writeUInt32LE(size, 24); // uncompressed size
    central.writeUInt16LE(nameBytes.length, 28); // filename length
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    // External attrs: regular file (0o100644) shifted left 16, but
    // JS bitwise ops produce signed int32 — multiply for the
    // unsigned UInt32LE slot.
    // eslint-disable-next-line no-bitwise -- Required for ZIP file format
    central.writeUInt32LE((0o10_0644 * 0x1_00_00) >>> 0, 38);
    central.writeUInt32LE(offset, 42); // relative offset of local header
    nameBytes.copy(central, 46);
    records.push({ local, central });
    localHeaders.push(local);
    centralHeaders.push(central);
    offset += local.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralHeaders) {
    centralSize += c.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4B_50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk where central starts
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  const total = Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
  return new Uint8Array(total.buffer, total.byteOffset, total.byteLength);
};

// CRC-32 (IEEE 802.3) — use crypto's md5 for nothing here; rolled
// inline to avoid pulling another dep. Polynomial 0xEDB88320.
let crcTable: Uint32Array | null = null;
const computeCrc32 = (data: Buffer): number => {
  if (crcTable === null) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        // eslint-disable-next-line no-bitwise -- Required for CRC32 calculation
        c = ((c & 1) === 0) ? (c >>> 1) : (0xED_B8_83_20 ^ (c >>> 1));
      }
      // eslint-disable-next-line no-bitwise -- Required for CRC32 table
      t[n] = c >>> 0;
    }
    crcTable = t;
  }
  let crc = 0xFF_FF_FF_FF;
  for (const datum of data) {
    // eslint-disable-next-line no-bitwise -- Required for CRC32 calculation
    crc = crcTable[(crc ^ datum) & 0xFF] ^ (crc >>> 8);
  }
  // eslint-disable-next-line no-bitwise -- Required for CRC32 calculation
  return (crc ^ 0xFF_FF_FF_FF) >>> 0;
};

/**
 * Convenience: SHA-256 the raw bundle contents (file-set hash, not
 * the zip bytes — the zip is non-deterministic across runs).
 * @param entries Files in the synthesized bundle.
 * @returns Lowercase hex sha256 of canonical (path|sha(file))* form.
 */
export const fileSetSha256 = (entries: readonly ZipEntry[]): string => {
  const hash = createHash('sha256');
  const sorted = [...entries].toSorted((a, b) => a.path.localeCompare(b.path));
  for (const e of sorted) {
    hash.update(e.path);
    hash.update('|');
    hash.update(Buffer.from(e.bytes));
    hash.update('\n');
  }
  return hash.digest('hex');
};
