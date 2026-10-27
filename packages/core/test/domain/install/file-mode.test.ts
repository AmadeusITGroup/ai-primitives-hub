/**
 * Tests for domain/install/file-mode.ts — carrying archive file modes
 * to the install writers and deciding the executable bit (issue #577).
 */
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  applyFileMode,
  isExecutableMode,
  withFileMode,
} from '../../../src/domain/install/file-mode';
import type {
  ExtractedFiles,
} from '../../../src/ports/bundle-extractor';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('withFileMode', () => {
  it('attaches a non-enumerable mode without changing the bytes', () => {
    const tagged = withFileMode(bytesOf('#!/bin/sh\n'), 0o755);

    expect(tagged.mode).toBe(0o755);
    expect(Object.keys(tagged)).not.toContain('mode');
    expect(tagged).toEqual(bytesOf('#!/bin/sh\n'));
  });

  it('returns the same object and keeps only the rwxrwxrwx bits', () => {
    const bytes = bytesOf('x');

    const tagged = withFileMode(bytes, 0o10_4755);

    expect(tagged).toBe(bytes);
    expect(tagged.mode).toBe(0o755);
  });

  it('survives the map copies made between extraction and the writers', () => {
    const files: ExtractedFiles = new Map([
      ['skills/demo/scripts/run.sh', withFileMode(bytesOf('run'), 0o755)],
      ['skills/demo/SKILL.md', bytesOf('skill')]
    ]);

    const copied = new Map(files);
    const filtered = new Map([...files].filter(([filePath]) => filePath.endsWith('.sh')));

    expect(copied.get('skills/demo/scripts/run.sh')?.mode).toBe(0o755);
    expect(filtered.get('skills/demo/scripts/run.sh')?.mode).toBe(0o755);
    expect(copied.get('skills/demo/SKILL.md')?.mode).toBeUndefined();
  });
});

describe('isExecutableMode', () => {
  it.each([
    ['0755', 0o755, true],
    ['0744', 0o744, true],
    ['0700', 0o700, true],
    ['0644', 0o644, false],
    ['0600', 0o600, false]
  ])('treats %s as executable=%s', (_label, mode, expected) => {
    expect(isExecutableMode(mode)).toBe(expected);
  });
});

describe('applyFileMode', () => {
  it('marks a file executable when its source mode has an execute bit', async () => {
    const fs = { setExecutable: vi.fn(() => Promise.resolve()) };

    await applyFileMode(fs, '/out/run.sh', withFileMode(bytesOf('run'), 0o755));

    expect(fs.setExecutable).toHaveBeenCalledWith('/out/run.sh', true);
  });

  it('clears the execute bits when the source mode has none', async () => {
    const fs = { setExecutable: vi.fn(() => Promise.resolve()) };

    await applyFileMode(fs, '/out/SKILL.md', withFileMode(bytesOf('skill'), 0o644));

    expect(fs.setExecutable).toHaveBeenCalledWith('/out/SKILL.md', false);
  });

  it('leaves the file alone when the source records no mode', async () => {
    const fs = { setExecutable: vi.fn(() => Promise.resolve()) };

    await applyFileMode(fs, '/out/prompt.md', bytesOf('prompt'));

    expect(fs.setExecutable).not.toHaveBeenCalled();
  });

  it('is a no-op for a filesystem without setExecutable', async () => {
    await expect(applyFileMode({}, '/out/run.sh', withFileMode(bytesOf('run'), 0o755)))
      .resolves.toBeUndefined();
  });
});
