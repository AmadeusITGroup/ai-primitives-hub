import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface GoldenFileEntry {
  path: string;
  content: string;
}

export interface GoldenFileTree {
  files: GoldenFileEntry[];
}

export async function readTargetFileTree(root: string): Promise<GoldenFileTree> {
  const files = await readFiles(root, '');

  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path))
  };
}

export async function assertTargetFileSystem(root: string, expected: GoldenFileTree): Promise<void> {
  const actual = await readTargetFileTree(root);

  assert.deepStrictEqual(actual, {
    files: expected.files.slice().sort((left, right) => left.path.localeCompare(right.path))
  });
}

async function readFiles(root: string, relativeRoot: string): Promise<GoldenFileEntry[]> {
  const absoluteRoot = path.join(root, relativeRoot);
  const entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  const files: GoldenFileEntry[] = [];

  for (const entry of entries) {
    if (entry.name === '.DS_Store') {
      continue;
    }

    const relativePath = relativeRoot ? path.join(relativeRoot, entry.name) : entry.name;

    if (entry.isDirectory()) {
      files.push(...await readFiles(root, relativePath));
      continue;
    }

    if (entry.isFile()) {
      files.push({
        path: toPosixPath(relativePath),
        content: await fs.readFile(path.join(root, relativePath), 'utf8')
      });
    }
  }

  return files;
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}