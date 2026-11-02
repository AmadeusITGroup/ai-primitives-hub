/**
 * Add an item to a collection in the shape of the published collection schema.
 * @module app/collection/add-collection-item
 */
import type {
  Collection,
  CollectionItem,
} from '@ai-primitives-hub/core';

/**
 * Item to add to a collection. `title` is the schema's display field.
 */
export interface NewCollectionItem {
  path: string;
  kind: string;
  title?: string;
  description?: string;
}

/**
 * Append an item to `collection.items`, building it in the shape of the
 * published collection schema: `path` and `kind`, plus `title` and
 * `description` only when they are non-empty strings. Never writes `name`.
 * Initializes `items` to an empty array when it is missing or null.
 * @param collection Collection to mutate.
 * @param item Item to add.
 * @returns The same collection.
 * @throws {Error} when `items` is present but not an array, so the caller
 * does not overwrite the declarations it holds. The collection is left
 * unchanged.
 */
export function addCollectionItem(collection: Collection, item: NewCollectionItem): Collection {
  const items: unknown = collection.items;
  if (items === undefined || items === null) {
    collection.items = [];
  } else if (!Array.isArray(items)) {
    throw new TypeError('Collection items must be an array; fix the collection file before adding items');
  }
  const entry: CollectionItem = { path: item.path, kind: item.kind };
  if (typeof item.title === 'string' && item.title.length > 0) {
    entry.title = item.title;
  }
  if (typeof item.description === 'string' && item.description.length > 0) {
    entry.description = item.description;
  }
  collection.items.push(entry);
  return collection;
}
