/**
 * `ai-primitives-hub explain <code>`.
 *
 * Looks up a structured RegistryError code and prints a paragraph of
 * documentation. The full code catalog is built incrementally; this
 * delivers a stub that recognizes the 11 namespaces and a curated set
 * of the codes commands actually emit. Codes that aren't yet
 * documented produce a generic "namespace recognized, but no entry yet"
 * message rather than failing — the catalog is filled out as new codes appear.
 * @module commands/explain
 */
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

/**
 * Known error namespaces. Must be kept in sync with `NAMESPACES` in
 * `@ai-primitives-hub/core`'s `domain/registry-error.ts` (only the
 * derived `RegistryErrorNamespace` *type* is exported publicly, not
 * the runtime array, so this list is a deliberate, documented
 * duplicate rather than an import).
 */
const KNOWN_NAMESPACES: ReadonlySet<string> = new Set([
  'BUNDLE',
  'INDEX',
  'HUB',
  'PRIMITIVE',
  'CONFIG',
  'NETWORK',
  'AUTH',
  'FS',
  'PLUGIN',
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
    remediation: 'Check the path is correct, or run from a repo root that has the expected folder.'
  },
  'FS.WRITE_FAILED': {
    summary: 'A target write failed (permissions, full disk, parent missing).',
    remediation: 'Check write permissions on the target path.'
  },
  'FS.SCAFFOLD_FAILED': {
    summary: 'Scaffolding a new primitive (skill/prompt/agent/etc.) from a template failed.',
    remediation: 'Check the --path directory is writable and does not already contain a conflicting file.'
  },
  'FS.COLLECTION_UPDATE_FAILED': {
    summary: 'A newly scaffolded primitive was created, but appending it to --collection <id> failed.',
    remediation: 'Check the collection.yml file is valid YAML and run `ai-primitives-hub collection validate`.'
  },
  'BUNDLE.NOT_FOUND': {
    summary: 'No bundle (collection or plugin) matched the requested identifier.',
    remediation: 'Run `ai-primitives-hub collection list` to see available collections.'
  },
  'BUNDLE.INVALID_MANIFEST': {
    summary: 'A collection or bundle manifest failed schema validation (missing required fields).',
    remediation: 'Run `ai-primitives-hub collection validate` for a per-file diagnosis.'
  },
  'BUNDLE.INVALID_VERSION': {
    summary: 'The collection.version field is not a valid semver string.',
    remediation: 'Edit the collection.yml file and ensure `version:` matches MAJOR.MINOR.PATCH.'
  },
  'BUNDLE.ITEM_NOT_FOUND': {
    summary: 'A collection item references a path that does not exist on disk.',
    remediation: 'Check the `items[].path` entries and ensure each file exists relative to the repo root.'
  },
  'BUNDLE.TAG_EXISTS': {
    summary: 'A manually-set collection.version already has a matching git tag.',
    remediation: 'Bump the `version:` field in the collection.yml or remove the existing tag.'
  },
  'BUNDLE.MANIFEST_MISSING': {
    summary: 'The bundle is missing `deployment-manifest.yml` at its root.',
    remediation: 'Verify the bundle was built with `ai-primitives-hub bundle build`. The manifest must live at the bundle root, not in a subdir.'
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
    remediation: 'Check that the downloaded zip is intact (no truncation), or re-build locally with `ai-primitives-hub bundle build`.'
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
  'HUB.NOT_FOUND': {
    summary: 'No active hub, or the requested hub id is not the currently active one.',
    remediation: 'Run `ai-primitives-hub hub add` to import a hub, then `hub use <id>` to activate it.'
  },
  'INDEX.NOT_FOUND': {
    summary: 'No primitive index file exists yet at the expected path.',
    remediation: 'Run `ai-primitives-hub index build` or `ai-primitives-hub index harvest` first.'
  },
  'NETWORK.DOWNLOAD_FAILED': {
    summary: 'The bundle could not be downloaded from the resolved URL.',
    remediation: 'Check connectivity and GitHub rate limits, and try `ai-primitives-hub doctor` for diagnostics.'
  },
  'CONFIG.SCHEMA_VERSION_UNSUPPORTED': {
    summary: 'The config or lockfile carries a schemaVersion this build does not understand.',
    remediation: 'Upgrade ai-primitives-hub, or roll back to a build matching the schema version on disk.'
  },
  'USAGE.MISSING_FLAG': {
    summary: 'A required CLI flag or argument was not provided.',
    remediation: 'Re-run with --help on the subcommand to see the required flags.'
  },
  'INTERNAL.UNEXPECTED': {
    summary: 'An unexpected error escaped a command handler. This is a bug.',
    remediation: 'Please report at https://github.com/AmadeusITGroup/ai-primitives-hub/issues with the stderr output.'
  }
};

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
  if (d.docsUrl !== null && d.docsUrl !== undefined) {
    lines.push(`Docs:        ${d.docsUrl}`);
  }
  return `${lines.join('\n')}\n`;
};

/**
 * Explain command class. Accepts a positional argument for the error code.
 */
export class ExplainCommand extends Command {
  public static readonly paths = [['explain']];

  public static readonly usage = Command.Usage({
    description: 'Print documentation for a RegistryError code.',
    category: 'Configure & Debug',
    details: `
      Usage: ai-primitives-hub explain <NAMESPACE.CODE> [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub explain BUNDLE.NOT_FOUND
        ai-primitives-hub explain INDEX.NOT_FOUND
    `
  });

  public code = Option.String();
  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = this.output ?? 'text';

    if (!this.code) {
      const err = new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'explain: missing error code',
        hint: 'Usage: `ai-primitives-hub explain <NAMESPACE.CODE>` (e.g., BUNDLE.NOT_FOUND)'
      });
      emitError(ctx, fmt, err);
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
      emitError(ctx, fmt, err);
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
      output: fmt,
      status: 'ok',
      data,
      textRenderer: renderText
    });
    return Promise.resolve(0);
  }
}
