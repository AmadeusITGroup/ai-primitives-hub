/**
 * Scan a source checkout with the built-in scanner and return its findings in the form the quality
 * rating reads. Binary files, symlinks, large files and the folders named below are skipped, as is
 * anything listed in a `.scanignore` at the root.
 * @module app/quality/scan-source
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  QualityFinding,
  ScanFinding,
} from '@ai-primitives-hub/core';
import {
  scanDocument,
} from '@ai-primitives-hub/core';

export interface ScanSourceResult {
  findings: QualityFinding[];
  scannedFiles: number;
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', '.venv', 'coverage']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svgz', '.pdf', '.zip', '.gz', '.tar', '.tgz', '.bz2',
  '.xz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.jar', '.pyc', '.pyo',
  '.wasm', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac', '.ogg',
  '.webm', '.lock', '.node', '.map'
]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8000;
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

const toPosix = (value: string): string => value.split(path.sep).join('/');

const readScanIgnore = (root: string): string[] => {
  try {
    return fs.readFileSync(path.join(root, '.scanignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\/+$/, ''))
      .filter((line) => line !== '' && !line.startsWith('#'));
  } catch {
    return [];
  }
};

const isIgnored = (relative: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => relative === pattern || relative.startsWith(`${pattern}/`) || relative.includes(`/${pattern}/`) || relative.endsWith(`/${pattern}`));

const collectFiles = (root: string, directory: string, ignore: readonly string[], files: string[]): void => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = toPosix(path.relative(root, full));
    if (isIgnored(relative, ignore)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        collectFiles(root, full, ignore, files);
      }
    } else if (entry.isFile() && !BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
};

const readText = (file: string): string | undefined => {
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_FILE_BYTES || bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
      return undefined;
    }
    return bytes.toString('utf8');
  } catch {
    return undefined;
  }
};

const toQualityFinding = (finding: ScanFinding): QualityFinding => ({
  ruleId: finding.ruleId,
  title: finding.title,
  severity: finding.severity,
  confidence: finding.confidence,
  file: finding.file,
  line: finding.line
});

/**
 * Scan every text file under a checkout.
 * @param root - Checkout to scan
 */
export const scanSource = (root: string): ScanSourceResult => {
  const resolved = path.resolve(root);
  const files: string[] = [];
  collectFiles(resolved, resolved, readScanIgnore(resolved), files);
  const findings: ScanFinding[] = [];
  let scannedFiles = 0;
  for (const file of files.toSorted((a, b) => a.localeCompare(b))) {
    const text = readText(file);
    if (text === undefined) {
      continue;
    }
    scannedFiles += 1;
    findings.push(...scanDocument(toPosix(path.relative(resolved, file)), text));
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    || a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId));
  return { findings: findings.map((finding) => toQualityFinding(finding)), scannedFiles };
};
