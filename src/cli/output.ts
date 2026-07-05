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
