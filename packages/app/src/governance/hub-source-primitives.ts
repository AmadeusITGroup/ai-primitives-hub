/** Validate collection-referenced primitives in hub sources changed by a PR. */
import * as path from 'node:path';
import {
  type FileSystem,
  type GovernanceFinding,
  type HubEntity,
  isGovernedPrimitiveKind,
  normalizePrimitiveKind,
  normalizeRepoRelativePath,
} from '@ai-primitives-hub/core';
import type {
  FailureReason,
} from '@ai-primitives-hub/infra/governance';
import {
  listCollectionFiles,
  readCollection,
  validateCollectionFile,
} from '../collection/read-collection';
import {
  type LocalPrimitiveResult,
  validateLocalPrimitives,
} from './primitive-governance';
import {
  resolvePrimitivePath,
} from './primitive-path-safety';
import {
  type HubSourceAccess,
  withSourceCheckout,
} from './validate-collection-governance';

/**
 * Safety of one collection item path: escapes are PTH001, missing or unreadable items VAL001.
 * @param fs
 * @param dir Checkout directory.
 * @param itemPath Declared item path.
 */
async function itemPathProblem(fs: FileSystem, dir: string, itemPath: string): Promise<{ ruleId: string; reason: string } | undefined> {
  let relative: string;
  try {
    relative = normalizeRepoRelativePath(itemPath.replaceAll('\\', '/'));
  } catch {
    return { ruleId: 'PTH001', reason: 'is outside the source repository' };
  }
  try {
    await resolvePrimitivePath(fs, dir, relative);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return message.includes('outside')
      ? { ruleId: 'PTH001', reason: 'resolves outside the source repository' }
      : { ruleId: 'VAL001', reason: 'is missing or unreadable' };
  }
}

/**
 * Download one changed source; never execute its contents or load its policy.
 * @param fs
 * @param source
 * @param access
 */
export async function validateHubSourcePrimitives(
  fs: FileSystem, source: HubEntity, access?: HubSourceAccess
): Promise<LocalPrimitiveResult> {
  const result: LocalPrimitiveResult = { files: [], findings: [], applicableRules: [] };
  const failure = (file: string, message: string, ruleId = 'VAL001', verified?: boolean): GovernanceFinding => ({
    ruleId, severity: 'error', file: file === '' ? source.id : `${source.id}/${file}`, message, verified,
    subject: { kind: 'source', id: source.id }
  });
  const unreadable = (reason: FailureReason): LocalPrimitiveResult => ({ ...result, findings: [{
    ...failure('', `Could not download source '${source.id}': ${reason.reason}`, 'VAL001', false), problem: reason.reason, hint: reason.hint
  }] });
  return withSourceCheckout(access, source, unreadable, async (checkout) => {
    try {
      const hasCollections = await fs.exists(path.join(checkout.dir, 'collections'));
      if (hasCollections) {
        await resolvePrimitivePath(fs, checkout.dir, 'collections');
      }
      const collections = hasCollections ? listCollectionFiles(checkout.dir) : [];
      if (collections.length === 0) {
        result.findings.push(failure('', 'No collection files found for primitive validation.'));
      }
      const seen = new Set<string>();
      for (const file of collections) {
        try {
          await resolvePrimitivePath(fs, checkout.dir, file);
        } catch {
          result.findings.push(failure(file, 'Collection path is missing or resolves outside the source repository.', 'PTH001', false));
          continue;
        }
        // Item paths are checked before the collection validator reads referenced files.
        let items: unknown[];
        try {
          const raw = readCollection(checkout.dir, file);
          items = Array.isArray(raw.items) ? raw.items : [];
        } catch (error) {
          result.findings.push(failure(file, `Cannot read collection: ${error instanceof Error ? error.message : String(error)}`));
          continue;
        }
        let unsafe = false;
        for (const item of items) {
          const itemPath = (item as { path?: unknown } | null)?.path;
          if (typeof itemPath !== 'string') {
            continue;
          }
          const problem = await itemPathProblem(fs, checkout.dir, itemPath);
          if (problem) {
            result.findings.push(failure(file, `Collection item '${itemPath}' ${problem.reason}.`, problem.ruleId, false));
            unsafe = true;
          }
        }
        if (unsafe) {
          continue;
        }
        const parsed = validateCollectionFile(checkout.dir, file);
        if (!parsed.ok || !parsed.collection) {
          result.findings.push(failure(file, `Cannot validate collection primitives: ${parsed.errors.join('; ')}`));
          continue;
        }
        for (const item of parsed.collection.items) {
          const kind = normalizePrimitiveKind(item.kind);
          if (!isGovernedPrimitiveKind(kind)) {
            continue;
          }
          const input = normalizeRepoRelativePath(item.path.replaceAll('\\', '/'));
          const key = `${kind}\u0000${input}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          try {
            const local = await validateLocalPrimitives(fs, checkout.dir, [input], kind);
            result.files.push(...local.files.map((entry) => `${source.id}/${entry}`));
            result.applicableRules.push(...local.applicableRules);
            result.findings.push(...local.findings.map((finding) => ({ ...finding, file: `${source.id}/${finding.file ?? input}` })));
          } catch {
            result.findings.push(failure(input, 'Could not read the collection primitive; check its path and contents.'));
          }
        }
      }
      return { ...result, files: [...new Set(result.files)].toSorted(), applicableRules: [...new Set(result.applicableRules)].toSorted() };
    } catch {
      result.findings.push(failure('', 'Source paths could not be safely inspected.', 'PTH001', false));
      return result;
    }
  });
}
