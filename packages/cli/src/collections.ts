/**
 * Collection file utilities.
 * @module collections
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  Collection,
} from './types';
import {
  normalizeRepoRelativePath,
} from './validate';

/**
 * List all collection files in the repository.
 * @param repoRoot - Repository root path
 * @returns Array of collection file paths (repo-relative)
 */
export function listCollectionFiles(repoRoot: string): string[] {
  const collectionsDir = path.join(repoRoot, 'collections');
  return fs
    .readdirSync(collectionsDir)
    .filter((f) => f.endsWith('.collection.yml'))
    .map((f) => path.join('collections', f));
}

/**
 * Read and parse a collection YAML file.
 * @param repoRoot - Repository root path
 * @param collectionFile - Collection file path (absolute or repo-relative)
 * @returns Parsed collection object
 * @throws {Error} if file is invalid YAML or not an object
 */
export function readCollection(repoRoot: string, collectionFile: string): Collection {
  const abs = path.isAbsolute(collectionFile)
    ? collectionFile
    : path.join(repoRoot, collectionFile);
  const content = fs.readFileSync(abs, 'utf8');
  const collection = yaml.load(content) as Collection;

  if (!collection || typeof collection !== 'object') {
    throw new Error(`Invalid collection YAML: ${collectionFile}`);
  }

  return collection;
}

/**
 * Recursively list all files in a directory.
 * @param dirPath - Absolute path to directory
 * @param basePath - Base path for relative paths
 * @returns Array of repo-relative file paths
 */
function listFilesRecursively(dirPath: string, basePath: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursively(fullPath, basePath));
    } else {
      const relPath = path.relative(basePath, fullPath).replace(/\\/g, '/');
      results.push(relPath);
    }
  }
  return results;
}

/**
 * Resolve all item paths referenced in a collection.
 * For skills, expands the skill directory to include all files.
 * @param repoRoot - Repository root path
 * @param collection - Parsed collection object
 * @returns Array of normalized repo-relative paths
 */
export function resolveCollectionItemPaths(repoRoot: string, collection: Collection): string[] {
  const items = Array.isArray(collection.items) ? collection.items : [];
  const allPaths: string[] = [];

  for (const item of items) {
    if (!item || !item.path) {
      continue;
    }

    const normalizedPath = normalizeRepoRelativePath(item.path);

    if (item.kind === 'skill') {
      // For skills, the path points to SKILL.md but we need the entire directory
      const skillDir = path.dirname(path.join(repoRoot, normalizedPath));
      if (fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory()) {
        const skillFiles = listFilesRecursively(skillDir, repoRoot);
        allPaths.push(...skillFiles);
      } else {
        // Fallback: just include the path as-is if directory doesn't exist
        allPaths.push(normalizedPath);
      }
    } else {
      allPaths.push(normalizedPath);
    }
  }

  return allPaths;
}
