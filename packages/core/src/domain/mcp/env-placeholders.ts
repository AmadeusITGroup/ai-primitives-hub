/**
 * MCP environment-variable placeholder handling — pure domain logic.
 *
 * Bundles declare environment references in the VS Code form `${env:VAR}`
 * (optionally `${env:VAR:-default}`). Install must never resolve these against
 * the installer's environment: doing so writes secrets (tokens, passwords) to
 * the host's MCP config file in cleartext. Instead the placeholder is emitted
 * verbatim, translated to the syntax the target host resolves at runtime.
 *
 * Pure: no IO, no side effects, no framework imports.
 * @module domain/mcp/env-placeholders
 */

/**
 * Environment placeholder syntax a host resolves at runtime.
 * - `prefixed`: `${env:VAR}` (VS Code, Cursor, Windsurf).
 * - `bare`: `${VAR}` (Kiro, Claude Code).
 */
export type McpEnvPlaceholderStyle = 'prefixed' | 'bare';

/** All supported placeholder styles, for validation. */
export const MCP_ENV_PLACEHOLDER_STYLES: readonly McpEnvPlaceholderStyle[] = ['prefixed', 'bare'];

/**
 * Rewrite `${env:...}` placeholders into the target host's runtime syntax.
 * Never resolves a value: the variable name and any `:-default` suffix are kept.
 * @param value - String possibly containing `${env:VAR}` placeholders.
 * @param style - Target host's placeholder style.
 * @returns The string with placeholders translated (unchanged for `prefixed`).
 */
export function rewriteEnvPlaceholders(value: string, style: McpEnvPlaceholderStyle): string {
  if (style === 'prefixed') {
    return value;
  }
  return value.replaceAll(/\$\{env:([^}]+)\}/g, (_m, body: string) => `\${${body}}`);
}
