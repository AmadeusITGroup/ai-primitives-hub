/**
 * Message builders for collection `kind: plugin` item findings.
 *
 * Shared by `collection validate` (`validateCollectionFile`) and
 * `bundle build` (`planBundleRelease`) so both report the exact same
 * strings for the same item. The rules themselves live in core
 * (`validateAgentPluginItem`); this module only formats their results.
 * Internal to `app`: not exported from the collection barrel.
 * @module app/collection/plugin-item-issues
 */
import type {
  AgentPluginIssue,
} from '@ai-primitives-hub/core';

/** Plugin item findings split by severity. */
export interface PluginItemFindings {
  /** Messages for fatal issues; any entry fails validation. */
  errors: string[];
  /** Messages for non-fatal issues. */
  warnings: string[];
}

/**
 * Build the error reported when a collection item path does not exist.
 * @param collectionRel - Collection file path as reported to the user
 * @param index - Zero-based item index in `items`
 * @param itemPath - Normalized repo-relative item path
 * @returns The error message
 */
export function referencedFileNotFoundMessage(collectionRel: string, index: number, itemPath: string): string {
  return `${collectionRel}: items[${index}] referenced file not found: ${itemPath}`;
}

/**
 * Split Agent Plugin issues into error and warning messages.
 * @param collectionRel - Collection file path as reported to the user
 * @param index - Zero-based item index in `items`
 * @param itemPath - Normalized repo-relative item path
 * @param issues - Issues from `validateAgentPluginItem`, in check order
 * @returns Fatal issues as `errors`, non-fatal ones as `warnings`, order preserved
 */
export function splitPluginItemIssues(
  collectionRel: string,
  index: number,
  itemPath: string,
  issues: readonly AgentPluginIssue[]
): PluginItemFindings {
  const findings: PluginItemFindings = { errors: [], warnings: [] };
  for (const issue of issues) {
    const message = `${collectionRel}: items[${index}] plugin ${itemPath}: ${issue.message}`;
    (issue.severity === 'fatal' ? findings.errors : findings.warnings).push(message);
  }
  return findings;
}
