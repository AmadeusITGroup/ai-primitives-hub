/**
 * Layered YAML config loader.
 *
 * Implements the precedence chain:
 *   1. Built-in defaults
 *   2. User config         ($XDG_CONFIG_HOME/ai-primitives-hub/config.yml,
 *                           or ~/.config/ai-primitives-hub/config.yml)
 *   3. Project config      (./ai-primitives-hub.yml, walking upward
 *                           Cargo-style)
 *   4. Env vars            (AI_PRIMITIVES_HUB_<DOTTED_PATH> mapped to
 *                           camelCase keys)
 *   5. --config FILE       (explicit file override)
 *   6. --config KEY=VALUE  (single-key override; stub, full
 *                           support in a later iteration)
 *   7. CLI flags           (handled by `runCli`, not here)
 *   8. Profile activation  (later iteration alongside the formatter)
 *
 * Each layer is a plain object that gets *deeply merged* into the
 * accumulator. Later layers override earlier ones at the leaf level,
 * preserving sibling keys.
 *
 * No external config-loader library is used. We have js-yaml already as
 * a dependency, and the discovery rules are simple enough that a custom
 * loader stays under 100 lines and gives us full control over the
 * precedence semantics. (The choice is "any loader that gives us full ordering
 * control", and this hand-rolled implementation qualifies while saving
 * a transitive dep tree.)
 *
 * User-config root and project/env-var names rebranded per migration
 * plan §8 decision 3 (CLI-only, unreleased artifact — `prompt-registry`
 * -> `ai-primitives-hub`). Layer 2's root delegates to `infra`'s
 * `xdgConfigDir` (ADR-0005) instead of re-implementing the
 * `XDG_CONFIG_HOME`/`~/.config` fallback inline as the reference
 * branch's own version of this file does.
 * @module framework/config
 */
import * as path from 'node:path';
import {
  xdgConfigDir,
} from '@ai-primitives-hub/infra';
import {
  load as parseYaml,
} from 'js-yaml';

/**
 * Subset of `FsAbstraction` the loader needs. Kept narrower than
 * `FsAbstraction` so loadConfig() doesn't drag the full 8-op surface
 * into its signature — only what it actually uses.
 */
export interface ConfigFs {
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface LoadConfigOptions {
  /** Working directory to start the upward walk from. */
  cwd: string;
  /** Process-style env map (AI_PRIMITIVES_HUB_* keys are consumed). */
  env: Readonly<Record<string, string>>;
  /** Optional --config FILE path; if set, becomes layer 5. */
  configFile?: string;
  /** Filesystem surface (production fs or in-memory stub). */
  fs: ConfigFs;
}

/**
 * Resolved config — a plain Record with nested values. Specific keys
 * (`output`, `verbose`, `quiet`, `index`, etc.) are documented
 * but the loader is schema-agnostic: it produces a
 * Record and lets later iterations validate.
 */
export type Config = Record<string, unknown>;

const DEFAULTS: Config = {
  version: 1,
  output: 'text',
  verbose: false,
  quiet: false
};

const ENV_PREFIX = 'AI_PRIMITIVES_HUB_';
const PROJECT_CONFIG_NAMES = ['ai-primitives-hub.yaml', 'ai-primitives-hub.yml'];
const USER_CONFIG_FILENAME = 'config.yml';

/**
 * Load layered configuration.
 * @param opts cwd / env / configFile / fs.
 * @returns Deeply-merged Config object.
 * @throws {Error} If `configFile` is set but does not exist.
 */
export const loadConfig = async (opts: LoadConfigOptions): Promise<Config> => {
  const layers: Config[] = [DEFAULTS];

  const userLayer = await loadUserConfig(opts);
  if (userLayer !== undefined) {
    layers.push(userLayer);
  }

  const projectLayer = await loadProjectConfig(opts);
  if (projectLayer !== undefined) {
    layers.push(projectLayer);
  }

  const envLayer = loadEnvLayer(opts.env);
  if (Object.keys(envLayer).length > 0) {
    layers.push(envLayer);
  }

  if (opts.configFile !== undefined) {
    const fileLayer = await loadConfigFile(opts.configFile, opts.fs);
    layers.push(fileLayer);
  }

  return layers.reduce((acc, layer) => deepMerge(acc, layer), {} as Config);
};

/**
 * Layer 2: user config from $XDG_CONFIG_HOME or ~/.config.
 * @param opts cwd / env / fs.
 * @returns Parsed user config or undefined when the file is absent.
 */
const loadUserConfig = async (opts: LoadConfigOptions): Promise<Config | undefined> => {
  const userPath = path.join(xdgConfigDir(opts.env), USER_CONFIG_FILENAME);
  if (!(await opts.fs.exists(userPath))) {
    return undefined;
  }
  return parseYamlFile(userPath, opts.fs);
};

/**
 * Resolve the project config file path via Cargo-style upward walk.
 * @param opts cwd / fs.
 * @returns Absolute path to the first found config file, or undefined.
 */
export const resolveProjectConfigPath = async (opts: LoadConfigOptions): Promise<string | undefined> => {
  let dir = opts.cwd;
  while (true) {
    for (const name of PROJECT_CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (await opts.fs.exists(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
};

/**
 * Layer 3: project config via Cargo-style upward walk.
 * @param opts cwd / fs.
 * @returns Parsed project config or undefined when no file is found
 *          before reaching the filesystem root.
 */
const loadProjectConfig = async (opts: LoadConfigOptions): Promise<Config | undefined> => {
  const configPath = await resolveProjectConfigPath(opts);
  if (configPath === undefined) {
    return undefined;
  }
  return parseYamlFile(configPath, opts.fs);
};

/**
 * Layer 4: env vars. Keys starting with `AI_PRIMITIVES_HUB_` are mapped
 * to config keys with the following convention:
 *   - **Double underscore (`__`)** is the *path separator* — it nests
 *     a value into a sub-object. `AI_PRIMITIVES_HUB_INDEX__TTL=120`
 *     produces `{ index: { ttl: 120 } }`.
 *   - **Single underscore (`_`)** within a path segment produces a
 *     **camelCase** key. `AI_PRIMITIVES_HUB_INDEX_PATH=/x` produces
 *     `{ indexPath: '/x' }` (one segment, camelCase joined).
 *   - Values `"true"`/`"false"` coerce to booleans; pure numeric
 *     strings coerce to numbers.
 *
 * The double-underscore convention is borrowed from environments like
 * Helm, Hyperion, and various Java frameworks where nesting is common.
 * It keeps the bare single-underscore case readable for the simple
 * top-level flags (verbose, quiet, output) which are the usual case.
 * @param env Process-style env map.
 * @returns Sparse Config containing only the keys derived from env vars.
 */
const loadEnvLayer = (env: Readonly<Record<string, string>>): Config => {
  const out: Config = {};
  for (const [k, raw] of Object.entries(env)) {
    if (!k.startsWith(ENV_PREFIX)) {
      continue;
    }
    const tail = k.slice(ENV_PREFIX.length);
    if (tail.length === 0) {
      continue;
    }
    const segments = tail.split('__').filter((s) => s.length > 0);
    if (segments.length === 0) {
      continue;
    }
    const keyPath = segments.map((s) => toCamelCase(s));
    setAtPath(out, keyPath, coerceEnvValue(raw));
  }
  return out;
};

/**
 * Set a value at a nested key path, creating intermediate objects as
 * needed. Used by the env-var layer to honour the double-underscore
 * path-separator convention.
 * @param target Object to mutate.
 * @param keyPath Segments of the key path (camelCase already applied).
 * @param value  The value to set at the leaf.
 */
const setAtPath = (target: Config, keyPath: string[], value: unknown): void => {
  let cursor = target;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const seg = keyPath[i];
    const existing = cursor[seg];
    if (!isPlainObject(existing)) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Config;
  }
  // Safe: caller guarantees keyPath.length >= 1 via the segments filter.
  cursor[keyPath.at(-1) as string] = value;
};

/**
 * Layer 5: explicit `--config FILE` override.
 * @param file Absolute or cwd-relative path to a YAML config file.
 * @param fs   Filesystem surface used to check existence and read.
 * @returns Parsed config.
 * @throws {Error} If the file is not found.
 */
const loadConfigFile = async (file: string, fs: ConfigFs): Promise<Config> => {
  if (!(await fs.exists(file))) {
    throw new Error(`Config file not found: ${file}`);
  }
  return parseYamlFile(file, fs);
};

const parseYamlFile = async (file: string, fs: ConfigFs): Promise<Config> => {
  const raw = await fs.readFile(file);
  const parsed = parseYaml(raw);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== 'object') {
    throw new TypeError(`Config at ${file} must be a YAML mapping at top level`);
  }
  return parsed as Config;
};

const toCamelCase = (token: string): string => {
  const parts = token.toLowerCase().split('_').filter((p) => p.length > 0);
  if (parts.length === 0) {
    return '';
  }
  return parts.map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join('');
};

const coerceEnvValue = (raw: string): unknown => {
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (raw !== '' && /^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Deeply merge `over` into `base`. Plain objects merge recursively;
 * arrays and primitives are replaced wholesale by `over`. Later layers
 * win at the leaf level while preserving sibling keys from earlier
 * layers — which is what "deep merge" means.
 * @param base Earlier (lower-precedence) layer.
 * @param over Later (higher-precedence) layer.
 * @returns Merged Config (new object; inputs are not mutated).
 */
const deepMerge = (base: Config, over: Config): Config => {
  const out: Config = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const baseV = out[k];
    out[k] = isPlainObject(v) && isPlainObject(baseV) ? deepMerge(baseV, v) : v;
  }
  return out;
};
