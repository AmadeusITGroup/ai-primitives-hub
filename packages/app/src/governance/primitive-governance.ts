/**
 * Primitive rules over local files. The rules themselves are pure and live in core; this module only reads files.
 * @module app/governance/primitive-governance
 */
import * as path from 'node:path';
import {
  detectPrimitiveKind,
  type FileSystem,
  type GovernanceFinding,
  type GovernedPrimitiveKind,
  isPrimitiveFileOfKind,
  MAX_PRIMITIVE_BYTES,
  oversizePrimitiveFinding,
  primitiveFindings,
  primitiveRulesForKinds,
  validateSkillAssets,
} from '@ai-primitives-hub/core';
import {
  inside,
  resolvePrimitivePath,
} from './primitive-path-safety';

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out']);

/**
 * Bundled assets beside a SKILL.md, checked for size and readability like `skill validate`.
 * @param fs
 * @param skillFile Canonical SKILL.md path.
 * @param display Display path of the SKILL.md.
 */
async function skillAssetFindings(fs: FileSystem, skillFile: string, display: string): Promise<GovernanceFinding[]> {
  const folder = path.dirname(skillFile);
  const assets: { name: string; size?: number; error?: string }[] = [];
  for (const entry of await fs.readDirEntries(folder)) {
    if (entry.isDirectory || entry.name === 'SKILL.md') {
      continue;
    }
    try {
      const stat = await fs.stat(path.join(folder, entry.name));
      if (stat.isFile) {
        assets.push({ name: entry.name, size: stat.size });
      }
    } catch (error) {
      assets.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return validateSkillAssets(assets).map((message) => ({ ruleId: 'SKL001', severity: 'error', message, file: display }));
}

export interface LocalPrimitiveResult {
  files: string[];
  findings: GovernanceFinding[];
  applicableRules: string[];
}

/**
 * Validate primitive files and directories on disk.
 * @param fs Filesystem port.
 * @param repoRoot Root used for display paths.
 * @param inputs Files or directories, relative to the root.
 * @param kind Force a kind for every file; otherwise inferred from file names.
 * @throws {Error} When an explicit file has no recognisable kind, or nothing governed is found.
 */
export async function validateLocalPrimitives(
  fs: FileSystem, repoRoot: string, inputs: readonly string[], kind?: GovernedPrimitiveKind
): Promise<LocalPrimitiveResult> {
  const findings: GovernanceFinding[] = [];
  const files: { canonical: string; display: string; folder: string }[] = [];
  const directories = new Set<string>();
  const canonicalFiles = new Set<string>();
  const applicable = new Set<string>(inputs.length > 0 ? ['PTH001'] : []);
  const inspect = async (input: string, explicit: boolean): Promise<void> => {
    const absolute = path.resolve(repoRoot, input);
    const relative = path.relative(repoRoot, absolute);
    const display = (inside(path.resolve(repoRoot), absolute) ? relative : path.basename(input)).split(path.sep).join('/');
    let canonical: string;
    try {
      canonical = await resolvePrimitivePath(fs, repoRoot, absolute);
    } catch (error) {
      findings.push({ ruleId: 'PTH001', severity: 'error', verified: false, file: display,
        message: error instanceof Error ? error.message : 'Path containment could not be verified.' });
      return;
    }
    const stat = await fs.stat(canonical);
    if (stat.isDirectory) {
      if (directories.has(canonical)) {
        return;
      }
      directories.add(canonical);
      for (const entry of (await fs.readDirEntries(canonical)).toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await inspect(path.join(absolute, entry.name), false);
        }
      }
    } else if (stat.isFile && (explicit || (kind === undefined ? detectPrimitiveKind(display) !== undefined : isPrimitiveFileOfKind(display, kind)))) {
      if (kind === undefined && detectPrimitiveKind(display) === undefined) {
        throw new Error(`Cannot infer the primitive kind of '${input}'. Use --kind skill|agent|prompt|instruction|mcp-server.`);
      }
      if (!canonicalFiles.has(canonical)) {
        canonicalFiles.add(canonical);
        files.push({ canonical, display, folder: path.basename(path.dirname(absolute)) });
      }
    }
  };
  for (const input of inputs) {
    await inspect(input, true);
  }
  if (files.length === 0 && findings.length === 0) {
    throw new Error(`No skill, agent, prompt, instruction or MCP files found in: ${inputs.join(', ')}.`);
  }
  const inspected: string[] = [];
  for (const { canonical, display, folder } of files) {
    const stat = await fs.stat(canonical);
    const inspectedKind = kind ?? detectPrimitiveKind(display);
    if (inspectedKind) {
      for (const ruleId of primitiveRulesForKinds([inspectedKind])) {
        applicable.add(ruleId);
      }
    }
    if (stat.size > MAX_PRIMITIVE_BYTES) {
      findings.push(oversizePrimitiveFinding(display, inspectedKind ?? 'skill'));
      continue;
    }
    const content = await fs.readFile(canonical);
    inspected.push(display);
    findings.push(...primitiveFindings(display, content, kind, folder));
    if (inspectedKind === 'skill') {
      findings.push(...await skillAssetFindings(fs, canonical, display));
    }
  }
  return { files: inspected, findings, applicableRules: [...applicable].toSorted() };
}
