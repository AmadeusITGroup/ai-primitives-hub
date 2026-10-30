import type {
  HubScopeDocument,
  ValidationResult,
} from '@ai-primitives-hub/core';
import {
  validateHubConfigDocument,
} from '../hub/validate-hub-config';

/**
 * Validate the projected schema/global policies without inventing placeholder references.
 * @param head
 * @param selected
 */
export function validateHubScopeDocument(head: HubScopeDocument, selected: HubScopeDocument): ValidationResult {
  const result = validateHubConfigDocument(selected);
  const errors = result.errors.filter((message) => !selected.profiles.some((profile, index) => {
    const original = head.profiles.find((p) => p.id === profile.id);
    return Array.isArray(profile.bundles) && profile.bundles.length === 0
      && Array.isArray(original?.bundles) && original.bundles.length > 0
      && message === `/profiles/${index}/bundles: must NOT have fewer than 1 items`;
  }));
  return { ...result, valid: errors.length === 0, errors };
}
