import type {
  HubCollectionInventory,
} from '../../ports';
import {
  type HubScope,
  type HubScopeDocument,
  selectHubScope,
} from './hub-scope';
import {
  canonicalHubCollectionId,
} from './rules/collection';

/**
 * Full enabled collection inventories are context, not an audit of other source types.
 * @param head
 * @param scope
 */
export function hubScopeInventoryDocument(head: HubScopeDocument, scope: HubScope): HubScopeDocument {
  const selected = selectHubScope(head, scope);
  const needsCollections = selected.sources.some((source) => source.enabled === true
    && ['github', 'awesome-copilot', 'local-awesome-copilot'].includes(String(source.type)));
  return { ...selected, sources: needsCollections
    ? head.sources.filter((source) =>
      source.enabled === true && ['github', 'awesome-copilot', 'local-awesome-copilot'].includes(String(source.type)))
    : [] };
}

/**
 * Keep competing owners as context only for IDs selected for publication.
 * @param head
 * @param scope
 * @param inventory
 */
export function scopedHubInventory(head: HubScopeDocument, scope: HubScope, inventory: HubCollectionInventory): HubCollectionInventory {
  const changed = new Set([...scope.sources.added, ...scope.sources.modified,
    ...scope.reasons.filter((r) => r.entity === 'source' && r.reason === 'explicit selection').map((r) => r.id)]);
  const references = scope.references.map((ref) => {
    const source = head.sources.find((s) => s.id === ref.source);
    let id = ref.id;
    if (source?.type === 'github') {
      const repository = typeof source.url === 'string' ? source.url : `https://github.com/${typeof source.repository === 'string' ? source.repository : ''}`;
      const slug = repository.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      id = canonicalHubCollectionId(ref.id, slug);
    }
    return { sourceId: ref.source, id };
  });
  const candidates = (inventory.releaseCandidates ?? inventory.collections).filter((c) =>
    head.sources.some((source) => source.id === c.sourceId && source.enabled === true)
    && (changed.has(c.sourceId) || references.some((r) => r.sourceId === c.sourceId && r.id === c.id)));
  const relevantIds = new Set(candidates.map((c) => c.id));
  // An ID alone does not attribute a collision: at least one selected owner
  // must actually occur in the head inventory. Missing publication is separate.
  const collisionIds = new Set(inventory.collections.filter((c) => candidates.some((candidate) =>
    candidate.sourceId === c.sourceId && candidate.id === c.id)).map((c) => c.id));
  const needsUniqueness = relevantIds.size > 0 || head.sources.some((s) => changed.has(s.id) && s.enabled && ['github', 'awesome-copilot'].includes(String(s.type)));
  return { collections: inventory.collections.filter((c) => collisionIds.has(c.id)), releaseCandidates: candidates,
    unverifiedSources: needsUniqueness ? inventory.unverifiedSources : [] };
}
