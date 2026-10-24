/**
 * `createPlugin` use-case: scaffold an Agent Plugins 1.0.0 plugin.
 *
 * Writes `<parentDir>/<name>/plugin.json`: the plugin root is the directory
 * that contains `plugin.json`, and its name equals the manifest `name`
 * (the layout `collection validate` and the bundler expect). The name is
 * checked against core's spec rule before anything is written, and an
 * existing manifest is never overwritten.
 * @module app/collection/create-plugin
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AGENT_PLUGIN_MANIFEST_FILENAME,
  AGENT_PLUGIN_MANIFEST_SCHEMA_URI,
  generateSanitizedId,
  validateAgentPluginName,
} from '@ai-primitives-hub/core';
import {
  TEMPLATE_PATHS,
  TemplateEngine,
} from '@ai-primitives-hub/infra';

export interface CreatePluginOptions {
  /** Directory that receives the `<name>/` plugin directory (e.g. `<repo>/plugins`). */
  parentDir: string;
  /** Plugin name; also the plugin directory name. Must satisfy the Agent Plugins name rule. */
  name: string;
  /** Manifest `description` (default: `A <name> plugin`). */
  description?: string;
  /** Manifest `version` (default: `1.0.0`). */
  version?: string;
  /** Manifest `author.name`. */
  author?: string;
}

export type CreatePluginErrorCode = 'invalid-name' | 'already-exists' | 'scaffold-failed';

export interface CreatePluginResult {
  success: boolean;
  /** `<parentDir>/<name>`. */
  pluginDir: string;
  /** `<parentDir>/<name>/plugin.json`. */
  manifestPath: string;
  /** Files written (empty on failure before scaffolding). */
  createdFiles: string[];
  error?: { code: CreatePluginErrorCode; message: string; hint?: string };
}

/**
 * Suggest a valid name derived from an invalid one.
 * @param name - The rejected name.
 * @returns A hint, or undefined when no valid name can be derived.
 */
const suggestName = (name: string): string | undefined => {
  const candidate = generateSanitizedId(name);
  return validateAgentPluginName(candidate) === null ? `try "${candidate}"` : undefined;
};

/**
 * Scaffold `<parentDir>/<name>/plugin.json` with `$schema`, `name`,
 * `version`, `description` and `author`.
 * @param options - Target directory and manifest values
 * @returns Result with the written paths, or a coded error (nothing written)
 */
export async function createPlugin(options: CreatePluginOptions): Promise<CreatePluginResult> {
  const { parentDir, name } = options;
  const pluginDir = path.join(parentDir, name);
  const manifestPath = path.join(pluginDir, AGENT_PLUGIN_MANIFEST_FILENAME);
  const fail = (code: CreatePluginErrorCode, message: string, hint?: string): CreatePluginResult => ({
    success: false,
    pluginDir,
    manifestPath,
    createdFiles: [],
    error: { code, message, ...(hint === undefined ? {} : { hint }) }
  });

  const nameIssue = validateAgentPluginName(name);
  if (nameIssue !== null) {
    return fail('invalid-name', `Invalid plugin name: ${nameIssue.message}`, suggestName(name));
  }
  if (fs.existsSync(manifestPath)) {
    return fail('already-exists', `Plugin "${name}" already exists at ${manifestPath}`);
  }

  const result = await new TemplateEngine(TEMPLATE_PATHS.plugin).scaffoldProject(pluginDir, {
    projectName: name,
    collectionId: name,
    name,
    description: options.description || `A ${name} plugin`,
    version: options.version || '1.0.0',
    author: options.author,
    schemaUri: AGENT_PLUGIN_MANIFEST_SCHEMA_URI
  });
  if (!result.success) {
    return { ...fail('scaffold-failed', result.error || 'Scaffolding failed'), createdFiles: result.createdFiles };
  }
  return { success: true, pluginDir, manifestPath, createdFiles: result.createdFiles };
}
