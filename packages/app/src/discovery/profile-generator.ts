/**
 * Profile generator for discovery.
 *
 * Generates profile YAML from resource selections.
 * @module app/discovery/profile-generator
 */

import type {
  ProfileDraft,
  ResourceSelection,
} from '../../domain/discovery/types';

/**
 * Profile generator class.
 */
export class ProfileGenerator {
  /**
   * Generate a profile draft from selections.
   * @param name - Profile name.
   * @param description - Profile description.
   * @param selections - Resource selections.
   * @param icon - Profile icon (optional).
   * @returns Profile draft.
   */
  public generateDraft(
    name: string,
    description: string,
    selections: readonly ResourceSelection[],
    icon?: string
  ): ProfileDraft {
    return {
      id: `draft-${Date.now()}`,
      name,
      description,
      icon,
      selections,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Generate YAML from profile draft.
   * @param draft - Profile draft.
   * @returns YAML string.
   */
  public generateYaml(draft: ProfileDraft): string {
    const lines: string[] = [`name: ${draft.name}`, `description: ${draft.description}`];

    if (draft.icon) {
      lines.push(`icon: ${draft.icon}`);
    }

    lines.push('bundles:');

    // Add selected resources as bundles
    const selectedResources = draft.selections.filter((s) => s.selected);
    for (const selection of selectedResources) {
      lines.push(`  - ${selection.id}`);
    }

    return lines.join('\n');
  }
}
