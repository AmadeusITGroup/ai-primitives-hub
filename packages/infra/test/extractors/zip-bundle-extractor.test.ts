import {
  describe,
  expect,
  it,
} from 'vitest';
import {
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
});
