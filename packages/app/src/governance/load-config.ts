/**
 * Discover and validate the consumer governance configuration (`hub-governance.yml`).
 * @module app/governance/load-config
 */
import * as path from 'node:path';
import type {
  ArgvProcessRunner,
  FileSystem,
  GovernanceFinding,
  GovernancePolicy,
} from '@ai-primitives-hub/core';
import {
  parseGovernanceConfig,
  readGitBlob,
} from '@ai-primitives-hub/infra/governance';

/** Discovered at the repository root when no explicit path is given. */
export const GOVERNANCE_CONFIG_FILE = 'hub-governance.yml';

export interface LoadedGovernanceConfig {
  policy: GovernancePolicy;
  /** CFG001 findings; a non-empty list means the policy is ignored. */
  findings: GovernanceFinding[];
  /** Display path of the file that was used, if any. */
  file?: string;
}

/**
 * Parse configuration content that was already read (for example from a Git commit).
 * @param content YAML content, or undefined when the file does not exist.
 * @param file Display path.
 */
export function governanceConfigFromContent(content: string | undefined, file: string): LoadedGovernanceConfig {
  if (content === undefined) {
    return { policy: {}, findings: [] };
  }
  const parsed = parseGovernanceConfig(content, file);
  return { policy: parsed.policy ?? {}, findings: parsed.findings, file };
}

/**
 * Load an explicit configuration file, or discover `hub-governance.yml` at the repository root.
 * A missing explicit file is a CFG001 error; a missing discovered file means "all defaults".
 * @param fs Filesystem port.
 * @param repoRoot Repository root.
 * @param explicitPath Path given with `--policy`, relative to the root.
 */
export async function loadGovernanceConfig(fs: FileSystem, repoRoot: string, explicitPath?: string): Promise<LoadedGovernanceConfig> {
  const file = explicitPath ?? GOVERNANCE_CONFIG_FILE;
  const absolute = path.resolve(repoRoot, file);
  if (explicitPath === undefined && !(await fs.exists(absolute))) {
    return { policy: {}, findings: [] };
  }
  try {
    return governanceConfigFromContent(await fs.readFile(absolute), file);
  } catch (error) {
    return { policy: {}, file, findings: [{
      ruleId: 'CFG001', severity: 'error', file,
      message: `Unable to read governance configuration: ${error instanceof Error ? error.message : String(error)}`
    }] };
  }
}

/**
 * Read policies from the merge base in Git mode, otherwise from the working tree.
 * @param fs
 * @param request
 * @param request.repoRoot
 * @param request.policy
 * @param request.processRunner
 * @param mergeBase
 */
export async function loadScopedGovernanceConfig(
  fs: FileSystem, request: { repoRoot: string; policy?: string; processRunner?: ArgvProcessRunner }, mergeBase?: string
): Promise<LoadedGovernanceConfig> {
  if (mergeBase === undefined) {
    return loadGovernanceConfig(fs, request.repoRoot, request.policy);
  }
  const relative = path.relative(request.repoRoot, path.resolve(request.repoRoot, request.policy ?? GOVERNANCE_CONFIG_FILE));
  const file = relative.split(path.sep).join('/');
  try {
    if (!request.processRunner || !file || path.isAbsolute(relative) || file.split('/').includes('..') || file.includes('\\') || file.includes(':')
      || [...file].some((char) => char.codePointAt(0)! < 32)) {
      throw new Error('Policy must be a safe repository-relative path.');
    }
    const content = await readGitBlob(request.processRunner, request.repoRoot, mergeBase, file);
    if (content === undefined && request.policy !== undefined) {
      throw new Error('Explicit policy is missing from the merge base.');
    }
    return governanceConfigFromContent(content, file);
  } catch {
    const displayFile = file.startsWith('../') || path.isAbsolute(relative) ? path.basename(file) : file;
    return { policy: {}, file: displayFile,
      findings: [{ ruleId: 'CFG001', severity: 'error', file: displayFile,
        message: 'Unable to read governance configuration from the PR base. Explicit policies must exist at the merge base within the repository.' }] };
  }
}

/**
 * Show paths relative to the repository root so reports never expose runner paths.
 * @param findings
 * @param repoRoot
 */
export function withDisplayPaths(findings: readonly GovernanceFinding[], repoRoot: string): GovernanceFinding[] {
  const root = path.resolve(repoRoot);
  return findings.map((finding) => {
    if (finding.file === undefined) {
      return finding;
    }
    if (!path.isAbsolute(finding.file)) {
      return { ...finding, file: finding.file.replaceAll('\\', '/') };
    }
    const relative = path.relative(root, finding.file);
    return relative.startsWith('..') || path.isAbsolute(relative)
      ? { ...finding, file: path.basename(finding.file) }
      : { ...finding, file: relative.split(path.sep).join('/') };
  });
}
