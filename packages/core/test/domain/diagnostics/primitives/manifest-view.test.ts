/**
 * Tests for the tolerant deployment-manifest view.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  readManifestView,
} from '../../../../src/domain/diagnostics/primitives';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('readManifestView', () => {
  it('reads identity, items and the file inventory', () => {
    const view = readManifestView(bytes([
      'formatVersion: 1',
      'id: aph-e2e-only-prompt',
      'version: 1.0.0',
      'items:',
      '  - { id: hello-world.prompt, path: prompts/hello-world.prompt.md, kind: prompt }',
      'files:',
      '  - { path: prompts/hello-world.prompt.md, role: installable, size: 3, sha256: "sha256:abc" }',
      '  - { path: LICENSE, role: metadata }'
    ].join('\n')));
    expect(view).toBeDefined();
    expect(view!.formatVersion).toBe(1);
    expect(view!.id).toBe('aph-e2e-only-prompt');
    expect(view!.version).toBe('1.0.0');
    expect(view!.items).toEqual([{ id: 'hello-world.prompt', path: 'prompts/hello-world.prompt.md', kind: 'prompt' }]);
    expect([...view!.files]).toEqual([
      ['prompts/hello-world.prompt.md', { role: 'installable', size: 3, sha256: 'sha256:abc' }],
      ['LICENSE', { role: 'metadata', size: null, sha256: null }]
    ]);
  });

  it('tolerates malformed items and files', () => {
    const view = readManifestView(bytes('id: x\nitems: [ 3, { path: 7, kind: prompt } ]\nfiles: nope\n'));
    expect(view!.items).toEqual([
      { path: null, kind: null, id: null },
      { path: null, kind: 'prompt', id: null }
    ]);
    expect(view!.files.size).toBe(0);
    expect(view!.formatVersion).toBeUndefined();
  });

  it.each([
    ['a list', '- a\n- b\n'],
    ['a scalar', 'just text\n'],
    ['empty', ''],
    ['invalid YAML', 'id: [unterminated\n'],
    ['not UTF-8', '\uFFFF']
  ])('returns undefined for %s and never throws', (_name, text) => {
    expect(readManifestView(bytes(text))).toBeUndefined();
  });

  it('returns undefined for binary bytes', () => {
    expect(readManifestView(new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0xFF]))).toBeUndefined();
  });
});
