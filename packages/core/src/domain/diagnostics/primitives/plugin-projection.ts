/**
 * Domain layer — Agent Plugin projection checks of the primitive diagnostics.
 *
 * What an installed plugin item must provide beyond its copied directory
 * (ADR-0009, #549): each plugin skill projected into the target's skills
 * route (I11), each plugin MCP server projected into a target config file
 * (I12), and `${PLUGIN_ROOT}` in each projected server resolved to the
 * installed plugin root (I14). Only these facts are checked: the config
 * file's path and format, and the projected server's exact name, are left
 * to the target (a server counts as projected under its own name or an
 * owned form ending in `:<name>` or `__<name>`).
 *
 * Observed values are names (never per-target labels), so one known gap
 * covers every target and scope. Pure functions: no I/O.
 * @module domain/diagnostics/primitives/plugin-projection
 */
import * as path from 'node:path';
import type {
  SnapshotRoot,
} from '../../../ports/primitive-diagnostics-driver';
import type {
  TargetType,
} from '../../install/target';
import type {
  FixtureItem,
} from './catalogue';
import {
  PLUGIN_ROOT_PLACEHOLDER,
} from './fixture';
import {
  expectedDestination,
  PLACEMENT_OVERRIDES,
  PLACEMENT_ROOTS,
  PLACEMENT_ROUTES,
} from './placements';
import {
  resolveSandboxLabel,
} from './sandbox';
import type {
  DiagnosticCheck,
  DiagnosticScope,
  InvariantId,
} from './types';

/** Inputs of the projection checks of one installed case. */
export interface PluginProjectionInput {
  target: TargetType;
  /** Effective scope of the install. */
  scope: DiagnosticScope;
  /** The bundle's plugin items (`item.plugin` set). */
  items: readonly FixtureItem[];
  /** Archived installable files per item path. */
  archivedItemFiles: ReadonlyMap<string, readonly string[]>;
  /** Non-bookkeeping labels the install added or modified. */
  changed: ReadonlySet<string>;
  /** Text of the changed files, by label; absent entries count as unreadable. */
  installedText: ReadonlyMap<string, string>;
  /** Snapshot roots of the case; needed to resolve the installed plugin root. */
  roots?: readonly SnapshotRoot[];
}

/** Projection checks and the labels they account for. */
export interface PluginProjection {
  /** I11, one per plugin item. */
  skills: DiagnosticCheck[];
  /** I12, one per plugin item. */
  servers: DiagnosticCheck[];
  /** I14, one per plugin item. */
  resolution: DiagnosticCheck[];
  /** Labels I11 expects and config files I12 matched: I13 does not report them as unexpected. */
  projected: ReadonlySet<string>;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const check = (invariant: InvariantId, item: string, key: string, names: readonly string[], reason: string): DiagnosticCheck =>
  (names.length === 0
    ? { invariant, outcome: 'pass', item }
    : { invariant, outcome: 'fail', item, observed: { [key]: [...names].toSorted() }, detail: `${reason}: ${names.join(', ')}` });

/**
 * Whether a config key names a server: its own name or an owned form.
 * @param key - Property key.
 * @param name - Server name.
 * @returns True for `<name>`, `…:<name>` and `…__<name>`.
 */
const namesServer = (key: string, name: string): boolean => key === name || key.endsWith(`:${name}`) || key.endsWith(`__${name}`);

/**
 * Collect every object-valued property, at any depth, whose key names the server.
 * @param value - Parsed JSON.
 * @param name - Server name.
 * @param out - Accumulator.
 */
const collectEntries = (value: unknown, name: string, out: JsonObject[]): void => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectEntries(entry, name, out);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isObject(child) && namesServer(key, name)) {
      out.push(child);
    }
    collectEntries(child, name, out);
  }
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Strings a server is launched with: its args, env values and cwd.
 * @param entry - Projected server entry.
 * @returns The strings.
 */
const launchStrings = (entry: JsonObject): string[] => [
  ...(Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : []),
  ...(isObject(entry.env) ? Object.values(entry.env).filter((value): value is string => typeof value === 'string') : []),
  ...(typeof entry.cwd === 'string' ? [entry.cwd] : [])
];

/**
 * Evaluate I11, I12 and I14 for the plugin items of an installed case.
 * @param input - What the install placed, per item.
 * @returns One check per plugin item and invariant, and the labels they account for.
 */
export function evaluatePluginProjection(input: PluginProjectionInput): PluginProjection {
  const { target, scope, changed, installedText } = input;
  const projected = new Set<string>();
  const result: PluginProjection = { skills: [], servers: [], resolution: [], projected };
  // Plugin skills land where the target's own skill items do (e.g. `$HOME/.config/devin/skills/` for Devin at user scope).
  const skillOverride = PLACEMENT_OVERRIDES[target]?.[scope]?.skill;
  const skillRoot = skillOverride?.root ?? PLACEMENT_ROOTS[target][scope];
  const skillRoute = skillOverride?.route ?? PLACEMENT_ROUTES[target].skill;

  for (const item of input.items) {
    const components = item.plugin!;
    const archived = input.archivedItemFiles.get(item.path) ?? [];
    const pluginRoot = `${path.posix.dirname(item.path)}/`;
    const rootDestination = expectedDestination(target, scope, item, pluginRoot);
    const rootLabel = rootDestination.kind === 'file' ? rootDestination.label : undefined;

    // I11 — every file of each plugin skill lands under the target's skills route.
    if (skillRoute === undefined || skillRoute === 'config') {
      result.skills.push({ invariant: 'I11', outcome: 'not-applicable', item: item.path, detail: 'not applicable: the target has no skills route' });
    } else {
      const unprojectedSkills = components.skills.filter((skill) => {
        const prefix = `${pluginRoot}skills/${skill}/`;
        const labels = archived.filter((file) => file.startsWith(prefix))
          .map((file) => `${skillRoot}/${skillRoute}${skill}/${file.slice(prefix.length)}`);
        for (const label of labels) {
          projected.add(label);
        }
        return labels.length === 0 || labels.some((label) => !changed.has(label));
      });
      result.skills.push(check('I11', item.path, 'unprojected', unprojectedSkills, 'plugin skills not projected into the skills route'));
    }

    // I12 — each plugin MCP server is merged into a config file outside the plugin root.
    const entries = new Map<string, JsonObject[]>(components.mcpServers.map((name) => [name, []]));
    for (const label of [...changed].toSorted()) {
      const text = installedText.get(label);
      if (!label.endsWith('.json') || (rootLabel !== undefined && label.startsWith(rootLabel)) || text === undefined) {
        continue;
      }
      const parsed = parseJson(text);
      for (const [name, found] of entries) {
        const before = found.length;
        collectEntries(parsed, name, found);
        if (found.length > before) {
          projected.add(label);
        }
      }
    }
    const unprojectedServers = [...entries].filter(([, found]) => found.length === 0).map(([name]) => name);
    result.servers.push(check('I12', item.path, 'unprojected', unprojectedServers, 'plugin MCP servers not projected into a config file'));

    // I14 — a projected server has no ${PLUGIN_ROOT} left and is launched with the installed plugin root.
    const rootPath = rootLabel === undefined || input.roots === undefined
      ? undefined
      : resolveSandboxLabel(input.roots, rootLabel.replace(/\/$/, ''));
    const unresolved = [...entries].filter(([, found]) => !found.some((entry) =>
      !JSON.stringify(entry).includes(PLUGIN_ROOT_PLACEHOLDER)
      && rootPath !== undefined
      && launchStrings(entry).some((value) => value.includes(rootPath)))).map(([name]) => name);
    result.resolution.push(check('I14', item.path, 'unresolved', unresolved, `${PLUGIN_ROOT_PLACEHOLDER} not resolved to the installed plugin root`));
  }
  return result;
}
