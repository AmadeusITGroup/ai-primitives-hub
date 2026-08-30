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
    if (await hasDirectory(path.join(current, '.git')) || path.dirname(current) === current) {
      return result;
    }
    current = path.dirname(current);
  }
};

const hasDirectory = async (directory: string): Promise<boolean> => {
  try {
    return (await lstat(directory)).isDirectory();
  } catch {
    return false;
  }
};

const readBounded = async (file: string, limit: number): Promise<Uint8Array> => {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return new Uint8Array(buffer.subarray(0, result.bytesRead));
  } finally {
    await handle.close();
  }
};

const readIgnore = async (file: string, limits: SecurityResourceLimits): Promise<string | undefined> => {
  try {
    const bytes = await readBounded(file, limits.maxIgnoreBytes);
    if (bytes.byteLength > limits.maxIgnoreBytes) {
      return undefined;
    }
    const contents = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (contents.split(/\r\n|\n|\r/).length > limits.maxIgnoreLines) {
      return undefined;
    }
    return contents;
  } catch {
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
  warnings: { code: 'SECURITY.INVALID_SUPPRESSION'; sourcePath: string; line: number; message: string }[]
): Promise<IgnorePattern[]> => {
  const ancestors = await parentDirectories(start);
  for (const directory of ancestors.toReversed()) {
    const suppressionPath = path.join(directory, '.markdown.ignore');
    const suppressionText = await readIgnore(suppressionPath, limits);
    if (suppressionText !== undefined) {
      const parsed = parseSuppressionFile(suppressionText, suppressionPath);
      suppressions.push(...parsed.declarations.map((declaration) => ({ ...declaration, scopeRoot: directory })));
      warnings.push(...parsed.warnings);
    }
    const fileIgnorePath = path.join(directory, '.markdown-file.ignore');
    const fileIgnoreText = await readIgnore(fileIgnorePath, limits);
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

const rootId = (root: string): string => normalize(path.resolve(root));

export class NodeSecurityScanInput implements SecurityScanInput {
  public async collect(request: SecurityInputRequest, limits: SecurityResourceLimits, cancellation: SecurityCancellation): Promise<SecurityInputCollection> {
    const candidates: SecurityInputCandidate[] = [];
    const ignoredFiles: { path: string; reason: string; source?: string }[] = [];
    const skippedFiles: { path: string; reason: string }[] = [];
    const errors: { path?: string; code: string; message: string }[] = [];
    const suppressions: SuppressionDeclaration[] = [];
    const warnings: { code: 'SECURITY.INVALID_SUPPRESSION'; sourcePath: string; line: number; message: string }[] = [];
    let totalFiles = 0;

    for (const rawRoot of request.roots) {
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
      const rootReal = await realpath(absoluteRoot);
      const id = rootId(absoluteRoot);
      const inheritedPatterns: IgnorePattern[] = [];
      if (request.ignoreTrust === 'repository') {
        await readAncestors(rootStat.isDirectory() ? absoluteRoot : path.dirname(absoluteRoot), limits, suppressions, inheritedPatterns, warnings);
      } else if (request.ignoreTrust === 'baseline') {
        if (request.baselineSuppressionPath !== undefined) {
          const baseline = await readIgnore(request.baselineSuppressionPath, limits);
          if (baseline !== undefined) {
            const parsed = parseSuppressionFile(baseline, request.baselineSuppressionPath);
            suppressions.push(...parsed.declarations.map((declaration) => ({ ...declaration, scopeRoot: absoluteRoot })));
            warnings.push(...parsed.warnings);
          }
        }
        if (request.baselineFileIgnorePath !== undefined) {
          const baseline = await readIgnore(request.baselineFileIgnorePath, limits);
          if (baseline !== undefined) {
            inheritedPatterns.push(...parsePatterns(baseline, request.baselineFileIgnorePath, absoluteRoot));
          }
        }
      }

      if (rootStat.isFile()) {
        const inheritedIgnore = inheritedPatterns.find((entry) => matchesFilePattern(absoluteRoot, entry.scopeRoot, entry.pattern));
        if (request.ignoreTrust === 'repository' && inheritedIgnore !== undefined) {
          ignoredFiles.push({ path: absoluteRoot, reason: 'file-ignore', source: inheritedIgnore.source });
        } else if (extensionAllowed(absoluteRoot, request.extensions) || SETTINGS.has(path.basename(absoluteRoot))) {
          candidates.push({ id: absoluteRoot, rootId: id, absolutePath: absoluteRoot, displayPath: path.basename(absoluteRoot), depth: 0 });
        }
        continue;
      }

      const queue: QueueEntry[] = [{ absolutePath: absoluteRoot, rootId: id, rootReal, displayRoot: absoluteRoot, depth: 0, filePatterns: inheritedPatterns }];
      while (queue.length > 0) {
        cancellation.throwIfCancelled();
        const current = queue.shift()!;
        if (current.depth > limits.maxDepth) {
          skippedFiles.push({ path: current.absolutePath, reason: 'max-depth' });
          continue;
        }
        const localPatterns = [...current.filePatterns];
        if (request.ignoreTrust === 'repository') {
          const localIgnorePath = path.join(current.absolutePath, '.markdown-file.ignore');
          const localIgnoreText = await readIgnore(localIgnorePath, limits);
          if (localIgnoreText !== undefined) {
            localPatterns.push(...parsePatterns(localIgnoreText, localIgnorePath));
          }
          const localSuppressionPath = path.join(current.absolutePath, '.markdown.ignore');
          const localSuppressionText = await readIgnore(localSuppressionPath, limits);
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
          if (totalFiles >= limits.maxFiles) {
            errors.push({ code: 'SECURITY.LIMIT_EXCEEDED', message: 'Maximum file count exceeded.' });
            break;
          }
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
            }
            continue;
          }
          if (!stat.isFile()) {
            skippedFiles.push({ path: candidatePath, reason: 'special-file' });
            continue;
          }
          totalFiles++;
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
    const stat = await lstat(candidate.absolutePath).catch(() => undefined);
    if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
      return { error: { code: 'SECURITY.INPUT_CHANGED', message: `Input changed or is no longer a regular file: ${candidate.displayPath}` } };
    }
    if (stat.size > limits.maxFileBytes) {
      return { error: { code: 'SECURITY.LIMIT_EXCEEDED', message: `Input exceeds the ${limits.maxFileBytes}-byte file limit: ${candidate.displayPath}` } };
    }
    try {
      const bytes = await readBounded(candidate.absolutePath, limits.maxFileBytes);
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
