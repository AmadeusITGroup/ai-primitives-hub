/**
 * Collection file reading utilities (file-IO dependent).
 * @module app/collection/read-collection
 *
 * File-IO dependent collection reading functions.
 * Pure validation functions are in src/domain/collection/validate.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  AllCollectionsResult,
  Collection,
  FileValidationResult,
} from '@prompt-registry/core';
import {
  normalizeRepoRelativePath,
  validateCollectionObject,
} from '@prompt-registry/core';

/**
 * Load valid item kinds from the JSON schema (single source of truth).
 * Falls back to a default list if schema cannot be loaded.
 * @param schemaDir - Directory containing the schema file
 * @returns Array of valid item kinds
 */
export function loadItemKindsFromSchema(schemaDir?: string): string[] {
  try {
    const schemaPath = schemaDir
      ? path.join(schemaDir, 'collection.schema.json')
      : path.join(__dirname, '../../../schemas/collection.schema.json');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse returns any
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Dynamic schema access
    const kinds = schema?.properties?.items?.items?.properties?.kind?.enum;
    if (Array.isArray(kinds) && kinds.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Schema enum is string[]
      return kinds;
    }
  } catch {
    // Schema unavailable or malformed, use fallback
  }
  return ['prompt', 'instruction', 'agent', 'skill'];
}

/**
 * Validate a collection file from disk.
 * Checks YAML syntax, required fields, and referenced file existence.
 * @param repoRoot - Repository root path
 * @param collectionFile - Collection file path (absolute or repo-relative)
 * @returns Validation result with parsed collection
 */
export function validateCollectionFile(
  repoRoot: string,
  collectionFile: string
): FileValidationResult {
  const rel = collectionFile.replaceAll('\\', '/');
  const abs = path.isAbsolute(collectionFile)
    ? collectionFile
    : path.join(repoRoot, collectionFile);

  const errors: string[] = [];

  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`${rel}: Collection file not found`] };
  }

  let collection: Collection;
  try {
    collection = yaml.load(fs.readFileSync(abs, 'utf8')) as Collection;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, errors: [`${rel}: YAML parse error: ${message}`] };
  }

  const schema = validateCollectionObject(collection, rel);
  errors.push(...schema.errors);

  if (Array.isArray(collection?.items)) {
    collection.items.forEach((item, idx) => {
      if (!item?.path || typeof item.path !== 'string') {
        return;
      }
      let relPath: string;
      try {
        relPath = normalizeRepoRelativePath(item.path);
      } catch {
        return;
      }

      const itemAbs = path.join(repoRoot, relPath);
      if (!fs.existsSync(itemAbs)) {
        errors.push(`${rel}: items[${idx}] referenced file not found: ${relPath}`);
      }
    });
  }

  return { ok: errors.length === 0, errors, collection };
}

/**
 * Validate all collections in a repository, including duplicate detection.
 * @param repoRoot - Repository root path
 * @param collectionFiles - Array of collection file paths (repo-relative)
 * @returns Validation result
 */
export function validateAllCollections(
  repoRoot: string,
  collectionFiles: string[]
): AllCollectionsResult {
  const errors: string[] = [];
  const fileResults: ({ file: string } & FileValidationResult)[] = [];
  const seenIds = new Map<string, string>(); // id -> file path
  const seenNames = new Map<string, string>(); // name -> file path

  for (const file of collectionFiles) {
    const result = validateCollectionFile(repoRoot, file);
    fileResults.push({ file, ...result });
    errors.push(...result.errors);

    // Check for duplicate IDs and names
    if (result.collection) {
      const { id, name } = result.collection;

      if (id && seenIds.has(id)) {
        errors.push(`${file}: Duplicate collection ID '${id}' (also in ${seenIds.get(id)})`);
      } else if (id) {
        seenIds.set(id, file);
      }

      if (name && seenNames.has(name)) {
        errors.push(`${file}: Duplicate collection name '${name}' (also in ${seenNames.get(name)})`);
      } else if (name) {
        seenNames.set(name, file);
      }
    }
  }

  return { ok: errors.length === 0, errors, fileResults };
}

/**
 * Generate markdown content for PR comment from validation result.
 * @param result - Result from validateAllCollections
 * @param totalFiles - Total number of collection files
 * @returns Markdown content
 */
export function generateMarkdown(result: AllCollectionsResult, totalFiles: number): string {
  let md = '## 📋 Collection Validation Results\n\n';

  if (result.ok) {
    md += `✅ **All ${totalFiles} collection(s) validated successfully!**\n`;
  } else {
    md += `❌ **Validation failed with ${result.errors.length} error(s)**\n\n`;
    md += '### Errors\n\n';
    result.errors.forEach((err) => {
      md += `- ${err}\n`;
    });
  }

  return md;
}

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
      const relPath = path.relative(basePath, fullPath).replaceAll('\\', '/');
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
    if (!item?.path) {
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
