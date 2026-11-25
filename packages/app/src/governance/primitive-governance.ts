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
  primitiveFindings,
  primitiveRulesForKinds,
} from '@ai-primitives-hub/core';
import {
  resolvePrimitivePath,
} from './primitive-path-safety';

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out']);
/** Larger primitive files are reported, not parsed; kinds with mandatory validation fail. */
const MAX_PRIMITIVE_BYTES = 1024 * 1024;
const OVERSIZE_RULE: Record<GovernedPrimitiveKind, GovernanceFinding['ruleId']> = {
  skill: 'SKL001', agent: 'AGT001', prompt: 'PRM001', instruction: 'INS001', 'mcp-server': 'MCP003'
};
const BLOCKING_OVERSIZE = new Set<GovernedPrimitiveKind>(['skill', 'mcp-server']);

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
    const display = (relative.startsWith('..') || path.isAbsolute(relative) ? path.basename(input) : relative).split(path.sep).join('/');
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
      const oversizeKind = inspectedKind ?? 'skill';
      const severity = BLOCKING_OVERSIZE.has(oversizeKind) ? 'error' : 'warning';
      findings.push({ ruleId: OVERSIZE_RULE[oversizeKind], severity, verified: false, file: display,
        message: 'File is larger than 1 MB and could not be validated.' });
      continue;
    }
    const content = await fs.readFile(canonical);
    inspected.push(display);
    findings.push(...primitiveFindings(display, content, kind, folder));
  }
  return { files: inspected, findings, applicableRules: [...applicable].toSorted() };
}
