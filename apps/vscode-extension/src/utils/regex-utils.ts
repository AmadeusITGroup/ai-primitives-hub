/**
 * Regex utility functions for safe pattern matching and string replacement
 * Handles cross-platform path issues (Windows backslashes, special characters)
 */

/**
 * Escape special regex characters in a string
 * This prevents strings (like Windows paths) from being interpreted as regex patterns
 * @param str - String to escape
 * @returns Escaped string safe for use in RegExp constructor
 * @example
 * ```typescript
 * const path = 'C:\\Users\\Test\\file.txt';
 * const escaped = escapeRegex(path);
 * const regex = new RegExp(escaped); // Safe - won't throw
 * ```
 */
export function escapeRegex(str: string): string {
  // Escape all special regex characters: . * + ? ^ $ { } ( ) | [ ] \
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create a RegExp from a string, escaping special characters
 * @param pattern - Pattern string to convert to regex
 * @param flags - Optional regex flags (g, i, m, etc.)
 * @returns RegExp object
 * @example
 * ```typescript
 * const regex = createSafeRegex('path.with.dots', 'g');
 * // Matches literal "path.with.dots", not "path" followed by any chars
 * ```
 */
export function createSafeRegex(pattern: string, flags?: string): RegExp {
  return new RegExp(escapeRegex(pattern), flags);
}

/**
 * Replace all occurrences of a literal string in text
 * Safer than String.replace() with regex for dynamic patterns
 * @param text - Text to search in
 * @param search - Literal string to find (will be escaped)
 * @param replacement - Replacement string (special chars like $ and \ are preserved)
 * @returns Text with replacements
 * @example
 * ```typescript
 * const template = 'Path: {{PATH}}';
 * const windowsPath = 'C:\\Users\\Test';
 * const result = replaceAll(template, '{{PATH}}', windowsPath);
 * // Result: 'Path: C:\\Users\\Test' (backslashes preserved)
 * ```
 */
export function replaceAll(text: string, search: string, replacement: string): string {
  const escapedSearch = escapeRegex(search);
  const regex = new RegExp(escapedSearch, 'g');
  // Use function to prevent interpretation of $ and \ in replacement
  return text.replace(regex, () => replacement);
}

/**
 * Replace template variables in text with values
 * Handles special characters in both keys and values safely
 * @param text - Template text with placeholders
 * @param variables - Object with variable names and values
 * @param options - Configuration options
 * @param options.prefix
 * @param options.suffix
 * @returns Text with variables replaced
 * @example
 * ```typescript
 * const template = 'Install to: {{PATH}}, version: {{VERSION}}';
 * const result = replaceVariables(template, {
 *   PATH: 'C:\\Users\\Test',
 *   VERSION: '1.0.0'
 * });
 * ```
 */
export function replaceVariables(
    text: string,
    variables: Record<string, string>,
    options: {
      prefix?: string;
      suffix?: string;
    } = {}
): string {
  const { prefix = '{{', suffix = '}}' } = options;
  let result = text;

  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `${prefix}${key}${suffix}`;
    result = replaceAll(result, placeholder, value);
  }

  return result;
}
