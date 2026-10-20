/**
 * `doctor diagnostics --primitives` mode runner.
 *
 * Thin delivery: parses the `--kinds/--targets/--scopes` filters, lets core
 * plan the run, hands it to the app use case with the in-process driver,
 * and formats the report. No rules and no expected values live here.
 * @module doctor/primitives
 */
import {
  runPrimitiveDiagnostics,
} from '@ai-primitives-hub/app';
import {
  DIAGNOSTIC_SCOPES,
  type DiagnosticScope,
  planPrimitiveDiagnostics,
  type PrimitiveKind,
  TARGET_TYPES,
  type TargetType,
} from '@ai-primitives-hub/core';
import {
  ZipBundleExtractor,
} from '@ai-primitives-hub/infra';
import {
  type Context,
  failWith,
  formatOutput,
  type OutputFormat,
  parseCsv,
  parseCsvEnum,
  parseCsvKinds,
  RegistryError,
} from '../framework';
import {
  getPrimitiveDiagnosticCommandClasses,
  resolveWorkspacePath,
} from './diagnostics';
import {
  createInProcessPrimitiveDriver,
} from './primitive-driver';
import {
  outcomeWord,
  renderPrimitivesText,
} from './primitives-text';

/** Envelope command of the primitives mode. */
const COMMAND = 'doctor.diagnostics.primitives';

/** Options of one primitives-mode run, straight from the command flags. */
export interface PrimitivesModeOptions {
  output: OutputFormat;
  verbose: boolean;
  retainWorkspace: boolean;
  kinds?: string;
  targets?: string;
  scopes?: string;
}

const usageError = (message: string): RegistryError => new RegistryError({
  code: 'USAGE.INVALID_FLAG',
  message,
  hint: 'Run `ai-primitives-hub doctor diagnostics --help` for the allowed values.'
});

/**
 * Parse one CSV filter flag.
 * @param flag Flag name, for messages.
 * @param raw Raw flag value.
 * @param parseValues Enum parser; throws on a value outside the enum.
 * @returns The values, undefined when the flag is absent, or a usage error.
 */
const parseFilter = <T>(
  flag: string,
  raw: string | undefined,
  parseValues: (value: string) => T[] | undefined
): T[] | undefined | RegistryError => {
  const values = parseCsv(raw);
  if (values === undefined) {
    return undefined;
  }
  if (values.length === 0) {
    return usageError(`${flag} requires at least one value`);
  }
  try {
    return parseValues(values.join(','));
  } catch (error) {
    return usageError(`${flag}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Run `doctor diagnostics --primitives`.
 * @param ctx CLI context.
 * @param options Parsed command flags.
 * @returns Exit code: 0 when the report is ok, else 1.
 */
export const runPrimitivesMode = async (ctx: Context, options: PrimitivesModeOptions): Promise<number> => {
  const kinds = parseFilter<PrimitiveKind>('--kinds', options.kinds, parseCsvKinds);
  const targets = parseFilter<TargetType>('--targets', options.targets, (v) => parseCsvEnum(v, TARGET_TYPES, 'target type'));
  const scopes = parseFilter<DiagnosticScope>('--scopes', options.scopes, (v) => parseCsvEnum(v, DIAGNOSTIC_SCOPES, 'scope'));
  if (kinds instanceof RegistryError) {
    return failWith(ctx, options.output, COMMAND, kinds);
  }
  if (targets instanceof RegistryError) {
    return failWith(ctx, options.output, COMMAND, targets);
  }
  if (scopes instanceof RegistryError) {
    return failWith(ctx, options.output, COMMAND, scopes);
  }

  const plan = planPrimitiveDiagnostics({ kinds, targets, scopes });
  if (plan.bundles.length === 0) {
    const notCovered = plan.notCovered.kinds.length > 0 ? `; not covered yet: ${plan.notCovered.kinds.join(', ')}` : '';
    return failWith(ctx, options.output, COMMAND, usageError(`no primitive diagnostic case matches the filters${notCovered}`));
  }

  const report = await runPrimitiveDiagnostics(
    {
      fs: ctx.fs,
      extractor: new ZipBundleExtractor(),
      clock: ctx.clock,
      driver: createInProcessPrimitiveDriver({ ctx, commandClasses: getPrimitiveDiagnosticCommandClasses() }),
      ...(options.verbose
        ? {
          onProgress: (event): void => {
            const gaps = event.gapIds.length > 0 ? ` ${event.gapIds.join(',')}` : '';
            ctx.stderr.write(`  [primitives] ${event.id} ${outcomeWord(event.outcome)}${gaps}\n`);
          }
        }
        : {})
    },
    { plan, workspace: resolveWorkspacePath(), retainWorkspace: options.retainWorkspace }
  );

  formatOutput({
    ctx,
    command: COMMAND,
    output: options.output,
    status: report.ok ? 'ok' : 'error',
    data: report,
    textRenderer: (data) => renderPrimitivesText(data, { verbose: options.verbose })
  });
  return report.ok ? 0 : 1;
};
