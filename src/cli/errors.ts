export interface CliDiagnostic {
  code: string;
  message: string;
  resourceId?: string;
  severity?: 'error' | 'warning' | 'info';
  remediation?: string;
}

/**
 * Format a single diagnostic for stderr output.
 * @param diagnostic
 */
export function formatDiagnostic(diagnostic: CliDiagnostic): string {
  const resource = diagnostic.resourceId === undefined ? '' : ` (${diagnostic.resourceId})`;
  const remediation = diagnostic.remediation === undefined ? '' : ` — ${diagnostic.remediation}`;
  return `${diagnostic.code}${resource}: ${diagnostic.message}${remediation}\n`;
}

/**
 * Format multiple diagnostics for stderr output.
 * @param diagnostics
 */
export function formatDiagnostics(diagnostics: CliDiagnostic[]): string {
  return diagnostics.map((d) => formatDiagnostic(d)).join('');
}

/**
 * Map an unknown error to an actionable stderr message.
 * @param error
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message}\n`;
  }
  return `${String(error)}\n`;
}
