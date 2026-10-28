/**
 * Tests for app/records/record-store.ts (W3 load, atomic save; NFR1.1–NFR1.3,
 * NFR4.1, NFR4.4, NFR4.6, NFR7.1, NFR7.2).
 */
import {
  execFileSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type InstallRecord,
  LOCAL_RECORD_FILE_NAME,
  RECORD_FILE_NAME,
  RECORD_MAX_BYTES,
  type RecordLocation,
} from '@ai-primitives-hub/core';
import {
  NodeRecordFs,
  RecordSchemaValidator,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  RecordStore,
} from '../../src/records/record-store';
import {
  serializeRecord,
} from '../../src/records/serialize-record';
import {
  FakeRecordFs,
} from './fake-record-fs';
import {
  canSymlink,
  canSymlinkFile,
  createTempDir,
  expectRecordError,
  fixtureText,
  makeGitDir,
  symlinkDir,
} from './record-test-utils';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const GENERATED_BY = 'ai-primitives-hub-cli@0.3.0-test';
const validator = new RecordSchemaValidator();

const newStore = (recordFs = new NodeRecordFs()): RecordStore =>
  new RecordStore({ fs: recordFs, validator, generatedBy: GENERATED_BY, now: () => NOW });

describe('RecordStore', () => {
  let base: string;
  let root: string;
  let cleanup: () => void;
  let store: RecordStore;
  let committed: RecordLocation;
  let localOnly: RecordLocation;

  beforeEach(async () => {
    [base, cleanup] = createTempDir('record-store-');
    root = path.join(base, 'repo');
    makeGitDir(root);
    fs.mkdirSync(path.join(root, 'packages', 'web'), { recursive: true });
    store = newStore();
    [committed, localOnly] = await store.resolveRepository({ start: path.join(root, 'packages', 'web') });
  });

  afterEach(() => {
    cleanup();
  });

  const writeRecord = (text: string, location = committed): void => {
    fs.writeFileSync(location.path, text);
  };

  describe('resolveRepository', () => {
    it('returns the committed then the local-only location at the git root', () => {
      expect(committed).toEqual({ level: 'repository', root, path: path.join(root, RECORD_FILE_NAME), commitMode: 'commit' });
      expect(localOnly).toEqual({ level: 'repository', root, path: path.join(root, LOCAL_RECORD_FILE_NAME), commitMode: 'local-only' });
    });
  });

  describe('load', () => {
    it('gives an empty, prototype-free record for a missing file', async () => {
      const loaded = await store.load(committed);
      expect(loaded.exists).toBe(false);
      expect(loaded.record).toMatchObject({ version: '3.0.0', level: 'repository', generatedBy: GENERATED_BY, bundles: {}, sources: {} });
      expect(Object.getPrototypeOf(loaded.record)).toBeNull();
      expect(Object.getPrototypeOf(loaded.record.bundles)).toBeNull();
    });

    it('loads a valid record and keeps unknown fields', async () => {
      writeRecord(fixtureText('valid-3.0.0.json'));
      const loaded = await store.load(committed);
      expect(loaded.exists).toBe(true);
      expect(Object.keys(loaded.record.bundles['acme-prompts'].tools)).toEqual(['kiro', 'vscode']);
      expect(loaded.record.bundles['acme-prompts'].tools.vscode.futureEntryField).toEqual({ kept: true });
    });

    it('refuses invalid JSON, a newer major and an older major under the new name', async () => {
      writeRecord('{ "version": "3.0.0", ');
      await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
      writeRecord(fixtureText('newer-4.0.0.json'));
      await expectRecordError(store.load(committed), 'RECORD.NEWER_FORMAT');
      writeRecord(fixtureText('legacy-2.0.0.json'));
      await expectRecordError(store.load(committed), 'RECORD.LEGACY_UNMIGRATED');
    });

    it('refuses a __proto__ bundle id and a nested constructor key, leaving Object.prototype unchanged', async () => {
      for (const fixture of ['proto-bundle.json', 'proto-nested.json']) {
        writeRecord(fixtureText(fixture));
        const error = await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
        expect(String(error.context?.detail)).toMatch(/^forbidden key /);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).tools).toBeUndefined();
    });

    it('refuses a schema failure and an entry whose sourceId is not in sources', async () => {
      const record = JSON.parse(fixtureText('valid-3.0.0.json'));
      delete record.$schema;
      writeRecord(JSON.stringify(record));
      await expectRecordError(store.load(committed), 'RECORD.MALFORMED');

      const orphan = JSON.parse(fixtureText('valid-3.0.0.json'));
      orphan.bundles['acme-prompts'].tools.kiro.sourceId = 'gone';
      writeRecord(JSON.stringify(orphan));
      const error = await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
      expect(String(error.context?.detail)).toContain('is not a key of sources');
      expect(error.context?.file).toBe(RECORD_FILE_NAME);
    });

    it('refuses recorded paths with a .git segment (Layer A) or a ".." segment (schema)', async () => {
      writeRecord(fixtureText('bad-path-git.json'));
      await expectRecordError(store.load(committed), 'RECORD.PATH_OUTSIDE_ROOT');
      writeRecord(fixtureText('bad-path-dotdot.json'));
      await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
    });

    it('refuses a recorded path through a symlinked folder that leaves the root (Layer B)', async (context) => {
      if (!canSymlink(base)) {
        context.skip();
      }
      fs.mkdirSync(path.join(base, 'outside'));
      symlinkDir(path.join(base, 'outside'), path.join(root, '.kiro'));
      writeRecord(fixtureText('valid-3.0.0.json'));
      await expectRecordError(store.load(committed), 'RECORD.PATH_OUTSIDE_ROOT');
    });

    it('refuses a file over 10 MB', async () => {
      writeRecord(' '.repeat(RECORD_MAX_BYTES + 1));
      const error = await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
      expect(error.context?.detail).toBe('record larger than 10 MB');
      expect(error.hint).toContain('larger than 10 MB');
    });

    it('accepts a file of exactly 10 MB as far as the size gate goes', async () => {
      const text = fixtureText('valid-3.0.0.json');
      writeRecord(text + ' '.repeat(RECORD_MAX_BYTES - Buffer.byteLength(text)));
      expect((await store.load(committed)).exists).toBe(true);
    });

    it('refuses a folder named like the record', async () => {
      fs.mkdirSync(committed.path);
      const error = await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
      expect(error.context?.detail).toBe('not a regular file');
    });

    it('refuses invalid UTF-8', async () => {
      fs.writeFileSync(committed.path, Buffer.from([0x7B, 0xFF, 0xFE, 0x7D]));
      const error = await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
      expect(error.context?.detail).toBe('not valid UTF-8');
    });

    it.skipIf(process.platform === 'win32')('refuses a symlink to a device without reading it', async () => {
      fs.symlinkSync('/dev/zero', committed.path);
      await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
    });

    it.skipIf(process.platform === 'win32')('refuses a symlink to a FIFO inside the root without hanging', async (context) => {
      const fifo = path.join(root, 'pipe');
      try {
        execFileSync('mkfifo', [fifo]);
      } catch {
        context.skip();
      }
      fs.symlinkSync(fifo, committed.path);
      const error = await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
      expect(error.context?.detail).toBe('not a regular file (symlink target)');
    });

    it('refuses a record symlink that points outside the root', async (context) => {
      if (!canSymlinkFile(base)) {
        context.skip();
      }
      const outsideRecord = path.join(base, 'outside.json');
      fs.writeFileSync(outsideRecord, fixtureText('valid-3.0.0.json'));
      fs.symlinkSync(outsideRecord, committed.path, 'file');
      const error = await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
      expect(error.context?.detail).toBe('symlink target is outside the root');
    });
  });

  describe('save', () => {
    const recordWithBundle = async (location: RecordLocation): Promise<InstallRecord> => {
      const { record } = await store.load(location);
      const parsed = JSON.parse(fixtureText('valid-3.0.0.json'));
      record.bundles = parsed.bundles;
      record.sources = parsed.sources;
      return record;
    };

    it('writes the canonical bytes, stamped, and loads back the same record', async () => {
      const record = await recordWithBundle(committed);
      expect(await store.save(committed, record)).toEqual({ warnings: [] });
      const text = fs.readFileSync(committed.path, 'utf8');
      expect(JSON.parse(text)).toMatchObject({ generatedAt: NOW.toISOString(), generatedBy: GENERATED_BY, version: '3.0.0', level: 'repository' });
      expect(text).toBe(serializeRecord((await store.load(committed)).record));
      expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('refuses to overwrite a malformed file and leaves it byte-identical', async () => {
      const malformed = '{ "version": "3.0.0", "bundles": [ }';
      writeRecord(malformed);
      await expectRecordError(store.load(committed), 'RECORD.MALFORMED');
      const record = await recordWithBundle(localOnly);
      const error = await expectRecordError(store.save(committed, record), 'RECORD.MALFORMED');
      expect(String(error.context?.detail)).toContain('not loaded successfully');
      expect(fs.readFileSync(committed.path, 'utf8')).toBe(malformed);
    });

    it('refuses to save a location that was never loaded', async () => {
      const fresh = newStore();
      const record = await recordWithBundle(committed);
      await expectRecordError(fresh.save(committed, record), 'RECORD.MALFORMED');
      expect(fs.existsSync(committed.path)).toBe(false);
    });

    it('refuses to save a record that fails the schema', async () => {
      const record = await recordWithBundle(committed);
      record.bundles['acme-prompts'].tools.kiro.files[0].checksum = 'nope';
      await expectRecordError(store.save(committed, record), 'RECORD.MALFORMED');
      expect(fs.existsSync(committed.path)).toBe(false);
    });

    it('keeps a symlinked record as a link and updates its target', async (context) => {
      if (!canSymlinkFile(base)) {
        context.skip();
      }
      const target = path.join(root, 'config', 'shared.lock.json');
      fs.mkdirSync(path.dirname(target));
      fs.writeFileSync(target, fixtureText('valid-3.0.0.json'));
      fs.symlinkSync(target, committed.path, 'file');

      const { record } = await store.load(committed);
      delete record.bundles['acme-prompts'].tools.kiro;
      await store.save(committed, record);

      expect(fs.lstatSync(committed.path).isSymbolicLink()).toBe(true);
      expect(Object.keys(JSON.parse(fs.readFileSync(target, 'utf8')).bundles['acme-prompts'].tools)).toEqual(['vscode']);
    });

    it.skipIf(process.platform === 'win32')('gives the record the same mode as a sibling file written by the process', async () => {
      const sibling = path.join(root, 'sibling.md');
      fs.writeFileSync(sibling, 'x');
      await store.save(committed, await recordWithBundle(committed));
      const permissions = (file: string): string => fs.statSync(file).mode.toString(8).slice(-3);
      expect(permissions(committed.path)).toBe(permissions(sibling));
    });

    it('adds the local-only record to info/exclude, and warns when there is no git directory', async () => {
      await store.save(localOnly, await recordWithBundle(localOnly));
      expect(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8')).toContain(LOCAL_RECORD_FILE_NAME);

      const plain = path.join(base, 'plain');
      fs.mkdirSync(plain);
      const plainStore = newStore();
      const [, plainLocal] = await plainStore.resolveRepository({ start: plain });
      const result = await plainStore.save(plainLocal, await (async () => {
        const { record } = await plainStore.load(plainLocal);
        return record;
      })());
      expect(fs.existsSync(plainLocal.path)).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('info/exclude');
    });

    describe('with an in-memory RecordFs', () => {
      const fakeRoot = path.resolve('/repo');
      const fakeLocation: RecordLocation = {
        level: 'repository',
        root: fakeRoot,
        path: path.join(fakeRoot, RECORD_FILE_NAME),
        commitMode: 'commit'
      };
      const original = fixtureText('valid-3.0.0.json');

      const loadedFake = async (): Promise<{ fake: FakeRecordFs; fakeStore: RecordStore; record: InstallRecord }> => {
        const fake = new FakeRecordFs().addDir(path.join(fakeRoot, '.git')).addFile(fakeLocation.path, original);
        const fakeStore = newStore(fake);
        const { record } = await fakeStore.load(fakeLocation);
        delete record.bundles['acme-prompts'].tools.kiro;
        return { fake, fakeStore, record };
      };

      it('leaves the old content and removes the temp file when the rename fails', async () => {
        const { fake, fakeStore, record } = await loadedFake();
        fake.renameError = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
        const error = await expectRecordError(fakeStore.save(fakeLocation, record), 'RECORD.WRITE_FAILED');
        expect(error.context?.file).toBe(RECORD_FILE_NAME);
        expect(fake.read(fakeLocation.path)).toBe(original);
        expect(fake.paths().filter((p) => p.endsWith('.tmp'))).toEqual([]);
        expect(fake.calls.some((call) => call.startsWith('unlink '))).toBe(true);
      });

      it('reports WRITE_FAILED when the exclusive temp-file create fails', async () => {
        const { fake, fakeStore, record } = await loadedFake();
        fake.writeError = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        await expectRecordError(fakeStore.save(fakeLocation, record), 'RECORD.WRITE_FAILED');
        expect(fake.read(fakeLocation.path)).toBe(original);
      });

      it('writes the temp file beside the target, then renames it', async () => {
        const { fake, fakeStore, record } = await loadedFake();
        await fakeStore.save(fakeLocation, record);
        const [write, rename] = fake.calls.filter((call) => call.startsWith('writeFile') || call.startsWith('rename'));
        expect(write).toMatch(new RegExp(`^writeFile ${fakeRoot.replace(/\\/g, '\\\\')}[/\\\\]\\.${RECORD_FILE_NAME.replace(/\./g, '\\.')}\\.\\d+\\.[0-9a-f]{12}\\.tmp$`));
        expect(rename).toBe(`rename ${write.slice('writeFile '.length)} ${fakeLocation.path}`);
        expect(Object.keys(JSON.parse(fake.read(fakeLocation.path) ?? '{}').bundles['acme-prompts'].tools)).toEqual(['vscode']);
      });

      it('wraps an unexpected read error as RECORD.MALFORMED', async () => {
        const fake = new FakeRecordFs().addFile(fakeLocation.path, original);
        fake.readCapped = () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
        await expectRecordError(newStore(fake).load(fakeLocation), 'RECORD.MALFORMED');
      });
    });
  });
});
