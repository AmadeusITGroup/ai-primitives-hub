/**
 * `prompt-registry explain <code>`.
 *
 * Looks up a structured RegistryError code and prints a paragraph of
 * documentation. The full code catalog is built incrementally; this
 * delivers a stub that recognizes the 11 namespaces and a small initial
 * set of codes that the commands actually emit. Codes that aren't yet
 * documented produce a generic "namespace recognized, but no entry yet"
 * message rather than failing — the catalog is filled out as new codes appear.
 */
import {
  Command,
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
  getCommandContext,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

/**
 * Known error namespaces.
 */
const KNOWN_NAMESPACES: ReadonlySet<string> = new Set([
  'BUNDLE',
  'INDEX',
  'INSTALL',
  'CONFIG',
  'HUB',
  'SOURCE',
  'PROFILE',
  'TARGET',
  'FS',
  'USAGE',
  'INTERNAL'
]);

/**
 * Explain data structure.
 */
interface ExplainData {
  code: string;
  namespace: string;
  summary: string;
  remediation: string;
  docsUrl?: string | null;
}

/**
 * Catalog entry for error code documentation.
 */
interface CatalogEntry {
  summary: string;
  remediation: string;
  docsUrl?: string;
}

// Initial catalog. Every code emitted by commands gets an
// entry; new codes added should be added here in the
// same iteration that introduces them.
/**
 * Error code documentation catalog.
 */
const CATALOG: Record<string, CatalogEntry> = {
  'FS.NOT_FOUND': {
    summary: 'A required file or directory could not be found on disk.',
    remediation: 'Check the path is correct, or pass --cwd <repo-root> to redirect filesystem operations.'
  },
  'BUNDLE.NOT_FOUND': {
    summary: 'No bundle (collection or plugin) matched the requested identifier.',
    remediation: 'Run `prompt-registry collection list` to see available collections.'
  },
  'BUNDLE.INVALID_MANIFEST': {
    summary: 'A collection or bundle manifest failed schema validation (missing required fields).',
    remediation: 'Run `prompt-registry collection validate` for a per-file diagnosis.'
  },
  'BUNDLE.INVALID_VERSION': {
    summary: 'The collection.version field is not a valid semver string.',
    remediation: 'Edit the collection.yml file and ensure `version:` matches MAJOR.MINOR.PATCH.'
  },
  'BUNDLE.ITEM_NOT_FOUND': {
    summary: 'A collection item references a path that does not exist on disk.',
    remediation: 'Check the `items[].path` entries and ensure each file exists relative to the repo root.'
  },
  'PRIMITIVE.ALREADY_EXISTS': {
    summary: 'A skill folder with the requested name already exists.',
    remediation: 'Choose a different --skill-name or remove the existing folder.'
  },
  'PRIMITIVE.INVALID_NAME': {
    summary: 'The skill name failed the spec validation (e.g., contains whitespace).',
    remediation: 'Use only lowercase letters, digits, and hyphens.'
  },
  'PRIMITIVE.CREATE_FAILED': {
    summary: 'createSkill failed for an unspecified reason.',
    remediation: 'Re-run with verbose output and check the surrounding logs.'
  },
  'USAGE.MISSING_FLAG': {
    summary: 'A required CLI flag was not provided.',
    remediation: 'Re-run with --help on the subcommand to see the required flags.'
  },
  'INTERNAL.UNEXPECTED': {
    summary: 'An unexpected error escaped a command handler. This is a bug.',
    remediation: 'Please report at https://github.com/AmadeusITGroup/prompt-registry/issues with the stderr output.'
  },
  // Install-related codes.
  'BUNDLE.MANIFEST_MISSING': {
    summary: 'The bundle is missing `deployment-manifest.yml` at its root.',
    remediation: 'Verify the bundle was built with `prompt-registry bundle build`. The manifest must live at the bundle root, not in a subdir.'
  },
  'BUNDLE.MANIFEST_INVALID': {
    summary: 'The deployment-manifest.yml is malformed (bad YAML, missing id/version/name).',
    remediation: 'Open the manifest and ensure it is a YAML mapping with non-empty `id`, `version`, `name` fields.'
  },
  'BUNDLE.ID_MISMATCH': {
    summary: 'The manifest id differs from the requested bundle id.',
    remediation: 'Check the install command line; the bundle id and the manifest id must match.'
  },
  'BUNDLE.VERSION_MISMATCH': {
    summary: 'The manifest version differs from the requested bundle version.',
    remediation: 'Either install with --version matching the manifest, or `--version latest` to skip the check.'
  },
  'BUNDLE.EXTRACT_FAILED': {
    summary: 'The bundle bytes could not be unpacked.',
    remediation: 'Check that the downloaded zip is intact (no truncation), or re-build locally with `prompt-registry bundle build`.'
  },
  'NETWORK.DOWNLOAD_FAILED': {
    summary: 'The bundle could not be downloaded from the resolved URL.',
    remediation: 'Check connectivity, GitHub rate limits, and the bundle URL. Try `prompt-registry doctor` for diagnostics.'
  },
  'CONFIG.SCHEMA_VERSION_UNSUPPORTED': {
    summary: 'The config or lockfile carries a schemaVersion this build does not understand.',
    remediation: 'Upgrade prompt-registry, or roll back to a build matching the schema version on disk.'
  },
  'FS.WRITE_FAILED': {
    summary: 'A target write failed (permissions, full disk, parent missing).',
    remediation: 'Check write permissions on the target path; run `prompt-registry doctor` for environment diagnostics.'
  }
};

/**
 * Explain command options.
 */
export interface ExplainOptions {
  output?: OutputFormat;
  code: string;
}

/**
 * Build the `explain` command using defineCommand (for test compatibility).
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createExplainCommand = (
  opts: ExplainOptions
): CommandDefinition =>
  defineCommand({
    path: ['explain'],
    description: 'Print documentation for a RegistryError code.',
    category: 'Configure & Debug',
    run: ({ ctx }: { ctx: Context }): number => {
      const fmt = opts.output ?? 'text';

      if (!opts.code) {
        const err = new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'explain: missing error code',
          hint: 'Usage: `prompt-registry explain <NAMESPACE.CODE>` (e.g., BUNDLE.NOT_FOUND)'
        });
        emitError(ctx, fmt, err);
        return 1;
      }

      const [namespace, code] = opts.code.split('.');
      if (!namespace || !code) {
        const err = new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: `explain: invalid error code format "${opts.code}" (expected NAMESPACE.CODE)`,
          hint: 'Example: `prompt-registry explain BUNDLE.NOT_FOUND`'
        });
        emitError(ctx, fmt, err);
        return 1;
      }

      if (!KNOWN_NAMESPACES.has(namespace)) {
        const err = new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: `explain: unknown error namespace "${namespace}"`,
          hint: `Known namespaces: ${Array.from(KNOWN_NAMESPACES).join(', ')}`
        });
        emitError(ctx, fmt, err);
        return 1;
      }

      const entry = CATALOG[opts.code];
      if (entry) {
        formatOutput({
          ctx,
          command: 'explain',
          output: fmt,
          status: 'ok',
          data: {
            code: opts.code,
            namespace,
            summary: entry.summary,
            remediation: entry.remediation
          },
          textRenderer: (d) => `${d.code}: ${d.summary}\n\nRemediation: ${d.remediation}\n`
        });
        return 0;
      }

      // Placeholder for known namespace but undocumented code
      formatOutput({
        ctx,
        command: 'explain',
        output: fmt,
        status: 'ok',
        data: {
          code: opts.code,
          namespace,
          summary: `No catalog entry for ${opts.code} (namespace recognized, but code not yet documented).`
        },
        textRenderer: (d) => `${d.code}: ${d.summary}\n`
      });
      return 0;
    }
  });

/**
 * Explain command class.
 * Accepts a positional argument for the error code.
 */
export class ExplainCommand extends Command {
  public static readonly paths = [['explain']];

  public static readonly usage = Command.Usage({
    description: 'Print documentation for a RegistryError code.',
    category: 'Configure & Debug',
    details: `
      Usage: prompt-registry explain <NAMESPACE.CODE> [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry explain BUNDLE.NOT_FOUND
        prompt-registry explain INDEX.NOT_FOUND
    `
  });

  public code = Option.String();
  public output = Option.String('-o,--output');

  public execute(): Promise<number> {
    const ctx = getCommandContext(this);

    if (!this.code) {
      const err = new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'explain: missing error code',
        hint: 'Usage: `prompt-registry explain <NAMESPACE.CODE>` (e.g., BUNDLE.NOT_FOUND)'
      });
      emitError(ctx, (this.output ?? 'text') as OutputFormat, err);
      return Promise.resolve(1);
    }
    const dotIdx = this.code.indexOf('.');
    const namespace = dotIdx === -1 ? this.code : this.code.slice(0, dotIdx);
    if (!KNOWN_NAMESPACES.has(namespace)) {
      const err = new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: `unknown namespace: ${namespace}`,
        hint: `Valid namespaces: ${[...KNOWN_NAMESPACES].toSorted((a, b) => a.localeCompare(b)).join(', ')}`
      });
      emitError(ctx, (this.output ?? 'text') as OutputFormat, err);
      return Promise.resolve(1);
    }
    const entry = CATALOG[this.code];
    const data: ExplainData = entry === undefined
      ? {
        code: this.code,
        namespace,
        summary: `Code ${this.code} is in the recognized namespace ${namespace} but has no catalog entry yet.`,
        remediation: 'The catalog is filled out as new codes appear. Search the source for `code: \'CODE_NAME\'` if you need the throw site.',
        docsUrl: null
      }
      : {
        code: this.code,
        namespace,
        summary: entry.summary,
        remediation: entry.remediation,
        docsUrl: entry.docsUrl ?? null
      };
    formatOutput({
      ctx,
      command: 'explain',
      output: (this.output ?? 'text') as OutputFormat,
      status: 'ok',
      data,
      textRenderer: renderText
    });
    return Promise.resolve(0);
  }
}

/**
 * Emit error in appropriate format.
 * @param ctx CLI context.
 * @param output Output format.
 * @param err Registry error.
 */
const emitError = (ctx: Context, output: OutputFormat, err: RegistryError): void => {
  if (output === 'json' || output === 'yaml' || output === 'ndjson') {
    formatOutput({
      ctx,
      command: 'explain',
      output,
      status: 'error',
      data: null,
      errors: [err.toJSON()]
    });
  } else {
    renderError(err, ctx);
  }
};

/**
 * Render explain data as text.
 * @param d Explain data.
 * @returns Formatted text output.
 */
const renderText = (d: ExplainData): string => {
  const lines: string[] = [`${d.code}`, `  ${d.summary}`, '', `Remediation: ${d.remediation}`];
  if (d.docsUrl !== null) {
    lines.push(`Docs:        ${d.docsUrl}`);
  }
  return `${lines.join('\n')}\n`;
};
