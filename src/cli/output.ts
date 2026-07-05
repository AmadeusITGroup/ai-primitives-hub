export type CliJsonOutputCommand = 'inspect' | 'install' | 'list' | 'validate';

export type CliJsonOutputStatus = 'error' | 'ok' | 'warning';

export interface CliJsonOutputError {
  code: string;
  message: string;
  resourceId?: string;
}

export interface CliJsonOutputInput<T> {
  command: CliJsonOutputCommand;
  data: T;
  errors?: CliJsonOutputError[];
  meta?: Record<string, unknown>;
  status?: CliJsonOutputStatus;
  warnings?: string[];
}

export interface CliTextInstallData {
  success: boolean;
  bundleId: string;
  version: string;
  writtenFiles: string[];
  diagnostics: { code: string; message: string; resourceId?: string }[];
}

export interface CliTextUninstallData {
  success: boolean;
  bundleId: string;
  removedFiles: string[];
  diagnostics: { code: string; message: string; resourceId?: string }[];
}

export interface CliTextValidateData {
  valid: boolean;
  diagnostics: { code: string; message: string; resourceId?: string }[];
}

export interface CliTextListEntry {
  bundleId: string;
  version: string;
  target: { type: string; scope: string };
}

export interface CliTextInspectData {
  bundleId: string;
  version: string;
  resources: { kind: string; id: string }[];
}

/**
 * Render the stable JSON envelope used by machine-readable CLI output.
 * @param input
 */
export function renderJsonOutput<T>(input: CliJsonOutputInput<T>): string {
  return JSON.stringify({
    schemaVersion: 1,
    command: input.command,
    status: input.status ?? 'ok',
    data: input.data,
    warnings: input.warnings ?? [],
    errors: input.errors ?? [],
    meta: input.meta ?? {}
  });
}

/**
 * Render install result as human-readable text.
 * @param data
 */
export function renderInstallText(data: CliTextInstallData): string {
  if (!data.success) {
    return formatDiagnostics(data.diagnostics);
  }
  return `Installed ${data.bundleId}@${data.version}\n`;
}

/**
 * Render uninstall result as human-readable text.
 * @param data
 */
export function renderUninstallText(data: CliTextUninstallData): string {
  if (!data.success) {
    return formatDiagnostics(data.diagnostics);
  }
  return `Uninstalled ${data.bundleId} (${data.removedFiles.length} files removed)\n`;
}

/**
 * Render validate result as human-readable text.
 * @param data
 */
export function renderValidateText(data: CliTextValidateData): string {
  if (!data.valid) {
    return formatDiagnostics(data.diagnostics);
  }
  return 'Bundle is valid\n';
}

/**
 * Render list result as human-readable text.
 * @param entries
 */
export function renderListText(entries: CliTextListEntry[]): string {
  if (entries.length === 0) {
    return 'No bundles installed\n';
  }
  return entries
    .map((entry) => `${entry.bundleId}@${entry.version} (${entry.target.type}:${entry.target.scope})\n`)
    .join('');
}

/**
 * Render inspect result as human-readable text.
 * @param data
 */
export function renderInspectText(data: CliTextInspectData): string {
  const lines = [`Bundle: ${data.bundleId}@${data.version}\n`];
  for (const resource of data.resources) {
    lines.push(`  ${resource.kind}: ${resource.id}\n`);
  }
  return lines.join('');
}

function formatDiagnostics(diagnostics: { code: string; message: string; resourceId?: string }[]): string {
  return diagnostics
    .map((d) => {
      const resource = d.resourceId === undefined ? '' : ` (${d.resourceId})`;
      return `${d.code}${resource}: ${d.message}\n`;
    })
    .join('');
}
