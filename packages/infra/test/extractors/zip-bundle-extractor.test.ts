import AdmZip = require('adm-zip');
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  readZipEntryModes,
  ZipBundleExtractor,
} from '../../src/extractors/zip-bundle-extractor';
import {
  buildZip,
} from '../../src/writers/zip-writer';

describe('ZipBundleExtractor', () => {
  it('round-trips a zip built by buildZip back into an identical file map', async () => {
    const entries = [
      { path: 'deployment-manifest.yml', bytes: new TextEncoder().encode('id: my-bundle\nversion: 1.0.0\nname: My Bundle\n') },
      { path: 'prompts/foo.prompt.md', bytes: new TextEncoder().encode('# Foo prompt') }
    ];
    const zipBytes = buildZip(entries);

    const files = await new ZipBundleExtractor().extract(zipBytes);

    expect(files.size).toBe(2);
    expect(new TextDecoder().decode(files.get('deployment-manifest.yml'))).toBe(
      'id: my-bundle\nversion: 1.0.0\nname: My Bundle\n'
    );
    expect(new TextDecoder().decode(files.get('prompts/foo.prompt.md'))).toBe('# Foo prompt');
  });

  it('round-trips a larger, deflate-compressed entry correctly', async () => {
    const largeContent = 'line of repeated text\n'.repeat(500);
    const zipBytes = buildZip([{ path: 'large.md', bytes: new TextEncoder().encode(largeContent) }]);

    const files = await new ZipBundleExtractor().extract(zipBytes);

    expect(new TextDecoder().decode(files.get('large.md'))).toBe(largeContent);
  });

  it('excludes directory entries from the resulting map', async () => {
    const zipBytes = buildZip([{ path: 'nested/file.md', bytes: new TextEncoder().encode('content') }]);

    const files = await new ZipBundleExtractor().extract(zipBytes);

    for (const key of files.keys()) {
      expect(key.endsWith('/')).toBe(false);
    }
  });

  it('rejects with a descriptive error when the bytes are not a valid zip', async () => {
    const garbage = new TextEncoder().encode('not a zip file');

    await expect(new ZipBundleExtractor().extract(garbage)).rejects.toThrow(/Failed to extract bundle/);
  });

  it('rejects archive entries that escape the bundle root', async () => {
    const zipBytes = buildZip([{ path: '../outside.txt', bytes: new TextEncoder().encode('unsafe') }]);

    await expect(new ZipBundleExtractor().extract(zipBytes)).rejects.toThrow(/Unsafe ZIP path/);
  });
});

describe('readZipEntryModes', () => {
  const zipWithModes = (entries: { name: string; attr: number }[]): Uint8Array => {
    const zip = new AdmZip();
    for (const entry of entries) {
      zip.addFile(entry.name, Buffer.from('content'));
      const added = zip.getEntry(entry.name);
      if (added !== null) {
        added.attr = entry.attr;
      }
    }
    return zip.toBuffer();
  };

  it('returns the permission bits recorded for each file entry', () => {
    const modes = readZipEntryModes(zipWithModes([
      { name: 'scripts/run.sh', attr: 0o10_0755 * 0x1_00_00 },
      { name: 'assets/logo.png', attr: 0o10_0644 * 0x1_00_00 }
    ]));

    expect(modes.get('scripts/run.sh')).toBe(0o755);
    expect(modes.get('assets/logo.png')).toBe(0o644);
  });

  it('masks setuid/setgid/sticky bits and omits entries without a Unix mode', () => {
    const modes = readZipEntryModes(zipWithModes([
      { name: 'bin/tool', attr: 0o10_4755 * 0x1_00_00 },
      { name: 'windows.txt', attr: 0 }
    ]));

    expect(modes.get('bin/tool')).toBe(0o755);
    expect(modes.has('windows.txt')).toBe(false);
  });

  it('rejects archive entries that escape the bundle root', () => {
    const zipBytes = buildZip([{ path: '../outside.txt', bytes: new TextEncoder().encode('unsafe') }]);

    expect(() => readZipEntryModes(zipBytes)).toThrow(/Unsafe ZIP path/);
  });
});
