/**
 * Collection rules COL001-COL006. Pure: adapters supply release and inventory evidence.
 * @module domain/governance/rules/collection
 */
import type {
  GovernanceCollection,
  HubCollectionInventory,
  ReleaseLookupResult,
} from '../../../ports';
import {
  extractBundleIdentity,
} from '../../bundle/version';
import type {
  AllCollectionsResult,
} from '../../collection/types';
import type {
  GovernanceFinding,
  GovernanceRule,
} from '../types';

export const COLLECTION_RULES: readonly GovernanceRule[] = [
  { id: 'COL001', subjects: ['collection'], description: 'Collection IDs and names are unique within the repository',
    defaultSeverity: 'error', disableable: false, configurable: true, needsNetwork: false },
  { id: 'COL002', subjects: ['collection'], description: 'Collection has a published release',
    defaultSeverity: 'error', disableable: false, configurable: true, needsNetwork: true },
  { id: 'COL003', subjects: ['collection'], description: 'Collection author is non-empty',
    defaultSeverity: 'error', disableable: true, configurable: true, needsNetwork: false },
  { id: 'COL004', subjects: ['collection'], description: 'Collection ID is unique across enabled Hub sources',
    defaultSeverity: 'error', disableable: true, configurable: true, needsNetwork: true },
  { id: 'COL005', subjects: ['collection'], description: 'Collection structure and referenced files are valid',
    defaultSeverity: 'error', disableable: false, configurable: true, needsNetwork: false },
  { id: 'COL006', subjects: ['collection'], description: 'Collection validation advisories',
    defaultSeverity: 'warning', disableable: true, configurable: true, needsNetwork: false }
];

/**
 * Split a validator message such as `collections/a.collection.yml: items[0] referenced file not found: x.md`
 * into the file, a short problem shared by every file (`Referenced file not found`) and the detail (`x.md`).
 * The full message is kept for JSON output.
 * @param message
 */
function splitCollectionMessage(message: string): Pick<GovernanceFinding, 'file' | 'problem' | 'detail'> {
  const located = /^(\S+\.collection\.ya?ml): (.+)$/s.exec(message);
  if (!located) {
    return {};
  }
  const text = located[2].replace(/^items\[\d+\] /, '');
  const duplicate = /^Duplicate collection (ID|name) '([^']+)' \(also in (.+)\)$/.exec(text);
  if (duplicate) {
    return { file: located[1], problem: `Duplicate collection ${duplicate[1]}`, detail: `${duplicate[2]}, also in ${duplicate[3]}` };
  }
  const withDetail = /^([^:]+): (.+)$/s.exec(text);
  const [problem, detail] = withDetail ? [withDetail[1], withDetail[2]] : [text.split('. ')[0], undefined];
  return { file: located[1], problem: `${problem.charAt(0).toUpperCase()}${problem.slice(1)}`, ...(detail ? { detail } : {}) };
}

/**
 * Adapt existing collection validator results without duplicating structural validation.
 * @param result Output of the established repository-wide collection validator.
 */
export function collectionGovernanceFindings(result: AllCollectionsResult): GovernanceFinding[] {
  const structuralErrors = new Set(result.fileResults.flatMap((file) => file.errors));
  // The existing aggregator adds only repository-wide duplicate IDs/names to file errors.
  const findings: GovernanceFinding[] = result.errors.map((message) => ({
    ruleId: structuralErrors.has(message) ? 'COL005' : 'COL001', severity: 'error', message, ...splitCollectionMessage(message) }));
  findings.push(...result.warnings.map((message): GovernanceFinding => ({ ruleId: 'COL006', severity: 'warning', message, ...splitCollectionMessage(message) })));
  for (const file of result.fileResults) {
    const collection = file.collection;
    if (!collection || typeof collection !== 'object') {
      continue;
    }
    if (typeof collection.author !== 'string' || collection.author.trim() === '') {
      findings.push({ ruleId: 'COL003', severity: 'error', message: 'Collection author must be non-empty.', problem: 'Collection author is empty', file: file.file });
    }
  }
  return findings;
}

/**
 * Remove only a known repository prefix and the established GitHub version suffix.
 * @param bundleId Runtime bundle id or canonical collection id.
 * @param repositorySlug `owner/repo` of the GitHub source.
 */
export function canonicalHubCollectionId(bundleId: string, repositorySlug: string): string {
  const prefix = `${repositorySlug.replaceAll('/', '-')}-`;
  const identity = extractBundleIdentity(bundleId, 'github');
  return identity.startsWith(prefix) ? identity.slice(prefix.length) : identity;
}

/**
 * Translate release evidence (COL002) while preserving unknown-data provenance.
 * @param collection Canonical collection identity.
 * @param result Release lookup evidence.
 */
export function releaseFindings(collection: GovernanceCollection, result: ReleaseLookupResult): GovernanceFinding[] {
  if (result.status === 'published') {
    return [];
  }
  const where = collection.repository ?? collection.sourceId;
  const subject = { kind: 'collection' as const, id: collection.id, source: collection.sourceId };
  return [result.status === 'missing'
    ? {
      ruleId: 'COL002', severity: 'error', verified: true, file: collection.file ?? collection.sourceId, subject,
      problem: 'Collection has no published release',
      message: `Collection '${collection.id}' has no published release in '${where}': no non-draft, non-prerelease release has a deployment manifest declaring this id and a .zip or .tar.gz bundle.`,
      hint: 'Publish a release of this collection (for example with the collection publish workflow) before adding it to the hub.'
    }
    : {
      ruleId: 'COL002', severity: 'error', verified: false, file: collection.file ?? collection.sourceId, subject,
      problem: result.message ?? 'Releases could not be read',
      message: `Could not check whether collection '${collection.id}' has a published release in '${where}'. Why: ${result.message ?? 'the releases could not be read.'}`,
      hint: result.hint ?? 'Supply an accessible repository and retry.'
    }];
}

/**
 * Detect collisions across source identities (COL004) and report incomplete inventories.
 * @param inventory Canonical hub-wide collection inventory.
 */
export function hubCollectionFindings(inventory: HubCollectionInventory): GovernanceFinding[] {
  const owners = new Map<string, Set<string>>();
  for (const collection of inventory.collections) {
    const sources = owners.get(collection.id) ?? new Set<string>();
    sources.add(collection.sourceId);
    owners.set(collection.id, sources);
  }
  const findings: GovernanceFinding[] = [];
  for (const [id, sources] of [...owners].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (sources.size > 1) {
      findings.push({ ruleId: 'COL004', severity: 'error', verified: true,
        subject: { kind: 'collection', id: `${id} (${[...sources].toSorted().join(', ')})` },
        problem: 'The same collection ID is in more than one source',
        message: `Collection ID '${id}' is used by more than one hub source: ${[...sources].toSorted().join(', ')}. Users could install the wrong collection.`,
        hint: 'Rename the collection in one of the sources so every collection ID in the hub is unique.' });
    }
  }
  findings.push(...inventory.unverifiedSources.map(({ sourceId, message, hint }): GovernanceFinding => ({
    ruleId: 'COL004', severity: 'error', verified: false, file: sourceId, subject: { kind: 'source', id: sourceId }, problem: message,
    message: `Could not read the collection IDs of source '${sourceId}', so hub-wide uniqueness cannot be confirmed. Why: ${message}`,
    hint: hint ?? 'Fix access to this source and retry.'
  })));
  return findings;
}
