/** Validate collection-referenced primitives in hub sources changed by a PR. */
import * as path from 'node:path';
import {
  type FileSystem,
  type GovernanceFinding,
  GOVERNED_PRIMITIVE_KINDS,
  type GovernedPrimitiveKind,
  type HubEntity,
  normalizePrimitiveKind,
  normalizeRepoRelativePath,
} from '@ai-primitives-hub/core';
import {
  describeFailure,
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
} from './primitive-path-safety-v1';
import type {
  HubSourceAccess,
} from './validate-collection-governance';

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
  const failure = (file: string, message: string, verified?: boolean): GovernanceFinding => ({
    ruleId: 'SKL001', severity: 'error', file: `${source.id}/${file}`, message, verified,
    subject: { kind: 'source', id: source.id }
  });
  if (!access) {
    result.findings.push(failure('', 'Source download is not configured. Run through the CLI, which supplies source access.', false));
    return result;
  }
  let checkout;
  try {
    checkout = await access.checkout(source);
  } catch (error) {
    const reason = describeFailure(error);
    result.findings.push({ ...failure('', `Could not download source '${source.id}': ${reason.reason}`, false), problem: reason.reason, hint: reason.hint });
    return result;
  }
  try {
    if (await fs.exists(path.join(checkout.dir, 'collections'))) {
      await resolvePrimitivePath(fs, checkout.dir, 'collections');
    }
    const collections = await fs.exists(path.join(checkout.dir, 'collections')) ? listCollectionFiles(checkout.dir) : [];
    if (collections.length === 0) {
      result.findings.push(failure('', 'No collection files found for primitive validation.'));
    }
    const seen = new Set<string>();
    for (const file of collections) {
      try {
        await resolvePrimitivePath(fs, checkout.dir, file);
      } catch {
        result.findings.push({ ...failure(file, 'Collection path is missing or resolves outside the source repository.', false), ruleId: 'PTH001' });
        continue;
      }
      const collection = readCollection(checkout.dir, file);
      let unsafe = false;
      for (const item of Array.isArray(collection.items) ? collection.items : []) {
        try {
          await resolvePrimitivePath(fs, checkout.dir, normalizeRepoRelativePath(item.path));
        } catch {
          result.findings.push({ ...failure(file, 'Referenced collection item is missing or resolves outside the source repository.', false), ruleId: 'PTH001' });
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
        if (kind === null || !(GOVERNED_PRIMITIVE_KINDS as readonly string[]).includes(kind)) {
          continue;
        }
        const input = normalizeRepoRelativePath(item.path);
        const key = `${kind}\u0000${input}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        try {
          const local = await validateLocalPrimitives(fs, checkout.dir, [input], kind as GovernedPrimitiveKind);
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
    result.findings.push({ ...failure('', 'Source paths could not be safely inspected.', false), ruleId: 'PTH001' });
    return result;
  } finally {
    await checkout.dispose();
  }
}
