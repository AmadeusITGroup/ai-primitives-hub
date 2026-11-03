import {
  constants,
} from 'node:fs';
import {
  lstat,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SecurityCancellation,
  SecurityDocument,
  SecurityInputCandidate,
  SecurityInputCollection,
  SecurityInputReadResult,
  SecurityInputRequest,
  SecurityResourceLimits,
  SecurityScanInput,
  SuppressionDeclaration,
} from '@ai-primitives-hub/core';
import {
  parseSuppressionFile,
} from '@ai-primitives-hub/core';

type IgnorePattern = { pattern: string; source: string; scopeRoot: string };
type QueueEntry = { absolutePath: string; rootId: string; rootReal: string; displayRoot: string; depth: number; filePatterns: IgnorePattern[] };
type InputError = { path?: string; code: string; message: string };

const DOC_FILES = new Set(['readme.md', 'changelog.md']);
const SETTINGS = new Set(['settings.json', 'settings.local.json']);
const DEFAULT_LIMITS: SecurityResourceLimits = {
  maxFiles: 10_000,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 104_857_600,
  maxDepth: 64,
  maxFindings: 5000,
  maxIgnoreBytes: 65_536,
  maxIgnoreLines: 1024,
  maxReportBytes: 10_485_760,
  timeoutMs: 60_000,
  documentTimeoutMs: 2000
};

const normalize = (value: string): string => value.replaceAll('\\', '/');
const isWithin = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const globMatch = (value: string, pattern: string): boolean => {
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      expression += '.*';
      index++;
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += /[\\^$+?.()|{}[\]]/.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${expression}$`).test(normalize(value));
};

const matchesFilePattern = (file: string, scope: string, pattern: string): boolean => {
  const normalizedPattern = normalize(pattern);
  if (path.isAbsolute(pattern)) {
    return globMatch(normalize(file), normalizedPattern);
  }
  const relative = normalize(path.relative(scope, file));
  return normalizedPattern.includes('/')
    ? globMatch(relative, normalizedPattern)
    : globMatch(path.posix.basename(relative), normalizedPattern);
};

const parentDirectories = async (start: string): Promise<string[]> => {
  const result: string[] = [];
  let current = path.resolve(start);
  while (true) {
    result.push(current);
    if (await hasRepositoryMarker(path.join(current, '.git')) || path.dirname(current) === current) {
      return result;
    }
    current = path.dirname(current);
  }
};

const hasRepositoryMarker = async (marker: string): Promise<boolean> => {
  try {
    const stat = await lstat(marker);
    return stat.isDirectory() || stat.isFile();
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const readBounded = async (file: string, limit: number): Promise<Uint8Array> => {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Input is not a regular file.');
  }
  // eslint-disable-next-line no-bitwise -- Filesystem open flags are a bitmask.
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Input changed while opening.');
    }
    const buffer = Buffer.alloc(limit + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const after = await lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error('Input changed while reading.');
    }
    return new Uint8Array(buffer.subarray(0, result.bytesRead));
  } finally {
    await handle.close();
  }
};

const readIgnore = async (file: string, limits: SecurityResourceLimits, errors: InputError[], required = false): Promise<string | undefined> => {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      errors.push({ path: file, code: 'SECURITY.INPUT_UNREADABLE', message: 'Ignore input is not a regular file.' });
      return undefined;
    }
    const bytes = await readBounded(file, limits.maxIgnoreBytes);
    if (bytes.byteLength > limits.maxIgnoreBytes) {
      errors.push({ path: file, code: 'SECURITY.LIMIT_EXCEEDED', message: 'Maximum ignore-file bytes exceeded.' });
      return undefined;
    }
    const contents = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (contents.split(/\r\n|\n|\r/).length > limits.maxIgnoreLines) {
      errors.push({ path: file, code: 'SECURITY.LIMIT_EXCEEDED', message: 'Maximum ignore-file lines exceeded.' });
      return undefined;
    }
    return contents;
  } catch (error) {
    const missing = error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    if (required || !missing) {
      errors.push({ path: file, code: 'SECURITY.INPUT_UNREADABLE', message: `Cannot read ignore input: ${error instanceof Error ? error.message : String(error)}` });
    }
    return undefined;
  }
};

const parsePatterns = (contents: string, source: string, scopeRoot = path.dirname(source)): IgnorePattern[] => contents.split(/\r\n|\n|\r/)
  .map((line) => line.trim().split('#', 1)[0].trim())
  .filter((line) => line.length > 0)
  .map((pattern) => ({ pattern, source, scopeRoot }));

const readAncestors = async (
  start: string,
  limits: SecurityResourceLimits,
  suppressions: SuppressionDeclaration[],
  filePatterns: IgnorePattern[],
  warnings: { code: 'SECURITY.INVALID_SUPPRESSION'; sourcePath: string; line: number; message: string }[],
  errors: InputError[]
): Promise<IgnorePattern[]> => {
  const ancestors = await parentDirectories(start);
  for (const directory of ancestors.toReversed()) {
    const suppressionPath = path.join(directory, '.markdown.ignore');
    const suppressionText = await readIgnore(suppressionPath, limits, errors);
    if (suppressionText !== undefined) {
      const parsed = parseSuppressionFile(suppressionText, suppressionPath);
      suppressions.push(...parsed.declarations.map((declaration) => ({ ...declaration, scopeRoot: directory })));
      warnings.push(...parsed.warnings);
    }
    const fileIgnorePath = path.join(directory, '.markdown-file.ignore');
    const fileIgnoreText = await readIgnore(fileIgnorePath, limits, errors);
    if (fileIgnoreText !== undefined) {
      filePatterns.push(...parsePatterns(fileIgnoreText, fileIgnorePath));
    }
  }
  return filePatterns;
};

const isExcluded = (file: string, patterns: readonly string[]): boolean => {
  const components = normalize(file).split('/');
  return patterns.some((pattern) => components.some((component) => globMatch(component, normalize(pattern))));
};

const extensionAllowed = (file: string, extensions: readonly string[]): boolean => {
  const lower = file.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`));
};

const rootId = (root: string): string => path.resolve(root);

const regularParents = async (file: string, root: string): Promise<boolean> => {
  let parent = path.dirname(file);
  while (isWithin(parent, root)) {
    const stat = await lstat(parent).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
      return false;
    }
    if (parent === root) {
      return true;
    }
    parent = path.dirname(parent);
  }
  return false;
};

export class NodeSecurityScanInput implements SecurityScanInput {
  public async collect(request: SecurityInputRequest, limits: SecurityResourceLimits, cancellation: SecurityCancellation): Promise<SecurityInputCollection> {
    const candidates: SecurityInputCandidate[] = [];
    const ignoredFiles: { path: string; reason: string; source?: string }[] = [];
    const skippedFiles: { path: string; reason: string }[] = [];
    const errors: { path?: string; code: string; message: string }[] = [];
    const suppressions: SuppressionDeclaration[] = [];
    const warnings: { code: 'SECURITY.INVALID_SUPPRESSION'; sourcePath: string; line: number; message: string }[] = [];
    let totalFiles = 0;
    let fileLimitExceeded = false;
    const seenFiles = new Set<string>();

    for (const rawRoot of request.roots) {
      if (fileLimitExceeded) {
        break;
      }
      cancellation.throwIfCancelled();
      const absoluteRoot = path.resolve(rawRoot);
      let rootStat;
      try {
        rootStat = await lstat(absoluteRoot);
      } catch {
        errors.push({ path: rawRoot, code: 'SECURITY.INPUT_NOT_FOUND', message: `Input not found: ${rawRoot}` });
        continue;
      }
      if (rootStat.isSymbolicLink()) {
        skippedFiles.push({ path: rawRoot, reason: 'symlink' });
        continue;
      }
      if (!rootStat.isFile() && !rootStat.isDirectory()) {
        skippedFiles.push({ path: rawRoot, reason: 'special-file' });
        continue;
      }
      if (isExcluded(absoluteRoot, request.excludes)) {
        skippedFiles.push({ path: absoluteRoot, reason: 'excluded' });
        continue;
      }
      if (rootStat.isFile() && seenFiles.has(absoluteRoot)) {
        continue;
      }
      const rootReal = await realpath(absoluteRoot);
      const id = rootId(rootStat.isDirectory() ? absoluteRoot : path.dirname(absoluteRoot));
      const inheritedPatterns: IgnorePattern[] = [];
      if (request.ignoreTrust === 'repository') {
        await readAncestors(rootStat.isDirectory() ? absoluteRoot : path.dirname(absoluteRoot), limits, suppressions, inheritedPatterns, warnings, errors);
      } else if (request.ignoreTrust === 'baseline') {
        if (request.baselineSuppressionPath !== undefined) {
          const baseline = await readIgnore(request.baselineSuppressionPath, limits, errors, true);
          if (baseline !== undefined) {
            const parsed = parseSuppressionFile(baseline, request.baselineSuppressionPath);
            suppressions.push(...parsed.declarations.map((declaration) => ({ ...declaration, scopeRoot: id })));
            warnings.push(...parsed.warnings);
          }
        }
        if (request.baselineFileIgnorePath !== undefined) {
          const baseline = await readIgnore(request.baselineFileIgnorePath, limits, errors, true);
          if (baseline !== undefined) {
            inheritedPatterns.push(...parsePatterns(baseline, request.baselineFileIgnorePath, id));
          }
        }
      }

      if (rootStat.isFile()) {
        if (totalFiles >= limits.maxFiles) {
          errors.push({ code: 'SECURITY.LIMIT_EXCEEDED', message: 'Maximum file count exceeded.' });
          break;
        }
        totalFiles++;
        seenFiles.add(absoluteRoot);
        const inheritedIgnore = inheritedPatterns.find((entry) => matchesFilePattern(absoluteRoot, entry.scopeRoot, entry.pattern));
        if (inheritedIgnore !== undefined) {
          ignoredFiles.push({ path: absoluteRoot, reason: 'file-ignore', source: inheritedIgnore.source });
        } else if (extensionAllowed(absoluteRoot, request.extensions) || SETTINGS.has(path.basename(absoluteRoot))) {
          candidates.push({ id: absoluteRoot, rootId: id, absolutePath: absoluteRoot, displayPath: path.basename(absoluteRoot), depth: 0 });
        }
        continue;
      }

      const queue: QueueEntry[] = [{ absolutePath: absoluteRoot, rootId: id, rootReal, displayRoot: absoluteRoot, depth: 0, filePatterns: inheritedPatterns }];
      while (queue.length > 0 && !fileLimitExceeded) {
        cancellation.throwIfCancelled();
        const current = queue.shift()!;
        if (current.depth > limits.maxDepth) {
          skippedFiles.push({ path: current.absolutePath, reason: 'max-depth' });
          continue;
        }
        const localPatterns = [...current.filePatterns];
        if (request.ignoreTrust === 'repository' && current.depth > 0) {
          const localIgnorePath = path.join(current.absolutePath, '.markdown-file.ignore');
          const localIgnoreText = await readIgnore(localIgnorePath, limits, errors);
          if (localIgnoreText !== undefined) {
            localPatterns.push(...parsePatterns(localIgnoreText, localIgnorePath));
          }
          const localSuppressionPath = path.join(current.absolutePath, '.markdown.ignore');
          const localSuppressionText = await readIgnore(localSuppressionPath, limits, errors);
          if (localSuppressionText !== undefined) {
            const parsed = parseSuppressionFile(localSuppressionText, localSuppressionPath);
            suppressions.push(...parsed.declarations.map((declaration) => ({ ...declaration, scopeRoot: current.absolutePath })));
            warnings.push(...parsed.warnings);
          }
        }
        let entries;
        try {
          entries = (await readdir(current.absolutePath, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name));
        } catch {
          errors.push({ path: current.absolutePath, code: 'SECURITY.INPUT_UNREADABLE', message: `Cannot read directory: ${current.absolutePath}` });
          continue;
        }
        for (const entry of entries) {
          const candidatePath = path.join(current.absolutePath, entry.name);
          const stat = await lstat(candidatePath).catch(() => undefined);
          if (stat === undefined) {
            errors.push({ path: candidatePath, code: 'SECURITY.INPUT_UNREADABLE', message: `Cannot inspect input: ${candidatePath}` });
            continue;
          }
          if (stat.isSymbolicLink()) {
            skippedFiles.push({ path: candidatePath, reason: 'symlink' });
            continue;
          }
          if (isExcluded(candidatePath, request.excludes)) {
            skippedFiles.push({ path: candidatePath, reason: 'excluded' });
            continue;
          }
          if (stat.isDirectory()) {
            if (request.recursive && current.depth < limits.maxDepth) {
              queue.push({ absolutePath: candidatePath, rootId: current.rootId, rootReal: current.rootReal, displayRoot: current.displayRoot, depth: current.depth + 1, filePatterns: localPatterns });
            } else if (request.recursive) {
              skippedFiles.push({ path: candidatePath, reason: 'max-depth' });
              errors.push({ path: candidatePath, code: 'SECURITY.LIMIT_EXCEEDED', message: 'Maximum directory depth exceeded.' });
            }
            continue;
          }
          if (!stat.isFile()) {
            skippedFiles.push({ path: candidatePath, reason: 'special-file' });
            continue;
          }
          if (seenFiles.has(candidatePath)) {
            continue;
          }
          if (totalFiles >= limits.maxFiles) {
            errors.push({ code: 'SECURITY.LIMIT_EXCEEDED', message: 'Maximum file count exceeded.' });
            fileLimitExceeded = true;
            break;
          }
          totalFiles++;
          seenFiles.add(candidatePath);
          const fileIgnore = localPatterns.find((pattern) => matchesFilePattern(candidatePath, pattern.scopeRoot, pattern.pattern));
          if (fileIgnore !== undefined) {
            ignoredFiles.push({ path: candidatePath, reason: 'file-ignore', source: fileIgnore.source });
            continue;
          }
          if (!extensionAllowed(candidatePath, request.extensions) && !(candidatePath.includes(`${path.sep}.claude${path.sep}`) && SETTINGS.has(entry.name))) {
            continue;
          }
          if (!request.includeDocFiles && DOC_FILES.has(entry.name.toLowerCase())) {
            skippedFiles.push({ path: candidatePath, reason: 'documentation-default' });
            continue;
          }
          const candidateReal = await realpath(candidatePath).catch(() => undefined);
          if (candidateReal === undefined || !isWithin(candidateReal, current.rootReal)) {
            errors.push({ path: candidatePath, code: 'SECURITY.PATH_ESCAPE', message: 'Input resolved outside the scan root.' });
            continue;
          }
          candidates.push({
            id: candidatePath,
            rootId: current.rootId,
            absolutePath: candidatePath,
            displayPath: normalize(path.relative(current.displayRoot, candidatePath)),
            depth: current.depth + 1
          });
        }
      }
    }

    return { candidates: candidates.toSorted((a, b) => a.rootId.localeCompare(b.rootId) || a.displayPath.localeCompare(b.displayPath)), ignoredFiles, skippedFiles, errors, suppressions, warnings };
  }

  public async read(candidate: SecurityInputCandidate, limits: SecurityResourceLimits, cancellation: SecurityCancellation): Promise<SecurityInputReadResult> {
    cancellation.throwIfCancelled();
    if (!await regularParents(candidate.absolutePath, candidate.rootId)) {
      return { error: { code: 'SECURITY.INPUT_CHANGED', message: `Input parent changed: ${candidate.displayPath}` } };
    }
    const stat = await lstat(candidate.absolutePath).catch(() => undefined);
    if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
      return { error: { code: 'SECURITY.INPUT_CHANGED', message: `Input changed or is no longer a regular file: ${candidate.displayPath}` } };
    }
    if (stat.size > limits.maxFileBytes) {
      return { error: { code: 'SECURITY.LIMIT_EXCEEDED', message: `Input exceeds the ${limits.maxFileBytes}-byte file limit: ${candidate.displayPath}` } };
    }
    try {
      const bytes = await readBounded(candidate.absolutePath, limits.maxFileBytes);
      if (!await regularParents(candidate.absolutePath, candidate.rootId)) {
        return { error: { code: 'SECURITY.INPUT_CHANGED', message: `Input parent changed: ${candidate.displayPath}` } };
      }
      if (bytes.byteLength > limits.maxFileBytes) {
        return { error: { code: 'SECURITY.LIMIT_EXCEEDED', message: `Input exceeds the file limit: ${candidate.displayPath}` } };
      }
      const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const document: SecurityDocument = {
        id: candidate.id,
        rootId: candidate.rootId,
        displayPath: candidate.displayPath,
        content,
        metadata: { bytes: bytes.byteLength, modifiedAtMs: stat.mtimeMs, posixMode: stat.mode, source: 'filesystem' }
      };
      return { document };
    } catch {
      return { error: { code: 'SECURITY.INPUT_UNREADABLE', message: `Cannot read input: ${candidate.displayPath}` } };
    }
  }
}

export { DEFAULT_LIMITS as SECURITY_DEFAULT_LIMITS };
