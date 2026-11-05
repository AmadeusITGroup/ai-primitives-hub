import * as fs from 'node:fs';
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
  affectedCollections,
} from '../../src/collection/affected-collections';

describe('affectedCollections', () => {
  let root: string;
  const file = 'collections/example.collection.yml';
  const selected = [{ id: 'example', file: path.join('collections', 'example.collection.yml') }];
  const writeCollection = (skillPath = 'skills/example/SKILL.md') => {
    fs.writeFileSync(path.join(root, file), `id: example
name: Example
readme:
  path: docs/overview.md
items:
  - path: ${skillPath}
    kind: skill
  - path: prompts/example.prompt.md
    kind: prompt
`);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-collections-'));
    fs.mkdirSync(path.join(root, 'collections'));
    fs.mkdirSync(path.join(root, 'skills/example/scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills/example/SKILL.md'), '# Example\n');
    fs.writeFileSync(path.join(root, 'skills/example/scripts/helper.js'), '// Helper\n');
    writeCollection();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('selects a collection when a supporting skill file was deleted', () => {
    fs.rmSync(path.join(root, 'skills/example/scripts/helper.js'));

    expect(affectedCollections(root, ['skills/example/scripts/helper.js'])).toEqual(selected);
  });

  it('selects a collection when the entire declared skill directory was deleted', () => {
    fs.rmSync(path.join(root, 'skills/example'), { recursive: true });

    expect(affectedCollections(root, ['skills/example/scripts/helper.js'])).toEqual(selected);
  });

  it('normalizes declared skill paths and Windows changed-path separators for deleted files', () => {
    writeCollection('./skills\\example\\SKILL.md');
    fs.rmSync(path.join(root, 'skills/example/scripts/helper.js'));

    expect(affectedCollections(root, ['skills\\example\\scripts\\helper.js'])).toEqual(selected);
  });

  it.each(['skills/example-other/helper.js', 'skills/examples/helper.js', 'skills/helper.js', 'prompts/other.prompt.md'])('does not match the sibling path %s', (changed) => {
    expect(affectedCollections(root, [changed])).toEqual([]);
  });

  it('preserves directory expansion for skill entries not named SKILL.md', () => {
    writeCollection('skills/example/entry.md');
    fs.rmSync(path.join(root, 'skills/example/scripts/helper.js'));

    expect(affectedCollections(root, ['skills/example/scripts/helper.js'])).toEqual(selected);
  });

  it.each([file, 'docs/overview.md', 'prompts/example.prompt.md', 'skills/example/SKILL.md', 'skills/example/scripts/helper.js'])('preserves the existing match for %s', (changed) => {
    expect(affectedCollections(root, [changed])).toEqual(selected);
  });
});
