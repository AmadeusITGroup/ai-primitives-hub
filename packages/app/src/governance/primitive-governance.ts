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
  primitiveFindings,
} from '@ai-primitives-hub/core';

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out']);
/** Larger primitive files are reported, not parsed. */
const MAX_PRIMITIVE_BYTES = 1024 * 1024;
const OVERSIZE_RULE: Record<GovernedPrimitiveKind, string> = {
  skill: 'SKL002', agent: 'AGT001', prompt: 'PRM001', instruction: 'INS001', 'mcp-server': 'MCP001'
};

async function walk(fs: FileSystem, directory: string, found: string[]): Promise<void> {
  for (const entry of (await fs.readDirEntries(directory)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walk(fs, full, found);
      }
    } else if (detectPrimitiveKind(entry.name) !== undefined) {
      found.push(full);
    }
  }
}

export interface LocalPrimitiveResult {
  files: string[];
  findings: GovernanceFinding[];
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
  const files: string[] = [];
  for (const input of inputs) {
    const absolute = path.resolve(repoRoot, input);
    const stat = await fs.stat(absolute);
    if (stat.isDirectory) {
      await walk(fs, absolute, files);
    } else {
      if (kind === undefined && detectPrimitiveKind(absolute) === undefined) {
        throw new Error(`Cannot infer the primitive kind of '${input}'. Use --kind skill|agent|prompt|instruction|mcp-server.`);
      }
      files.push(absolute);
    }
  }
  if (files.length === 0) {
    throw new Error(`No skill, agent, prompt, instruction or MCP files found in: ${inputs.join(', ')}.`);
  }
  const findings: GovernanceFinding[] = [];
  for (const file of files) {
    const display = path.relative(repoRoot, file).split(path.sep).join('/');
    const stat = await fs.stat(file);
    if (stat.size > MAX_PRIMITIVE_BYTES) {
      const ruleId = OVERSIZE_RULE[kind ?? detectPrimitiveKind(file) ?? 'skill'];
      findings.push({ ruleId, severity: 'warning', verified: false, file: display, message: 'File is larger than 1 MB and was not inspected.' });
      continue;
    }
    findings.push(...primitiveFindings(display, await fs.readFile(file), kind));
  }
  return { files: files.map((file) => path.relative(repoRoot, file).split(path.sep).join('/')), findings };
}
