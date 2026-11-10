import type {
  ValidatedManifest,
} from '../collection/manifest-validator';
import type {
  DeploymentManifest,
} from '../collection/types';

/** Manifest forms accepted on an installed-bundle record. */
export type InstalledManifest = DeploymentManifest | ValidatedManifest;

export interface InstalledManifestPrompt {
  id: string;
  name: string;
  description: string;
  file: string;
  type: string;
  tags?: string[];
}

export interface InstalledManifestDetails {
  name?: string;
  description?: string;
  repositoryUrl?: string;
  homepage?: string;
  prompts?: InstalledManifestPrompt[];
  mcpServers?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asTags = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : undefined;

const fromItem = (item: Record<string, unknown>): InstalledManifestPrompt | null => {
  const file = asString(item.path);
  const kind = asString(item.kind);
  if (!file || !kind) {
    return null;
  }
  const id = asString(item.id) ?? file;
  return {
    id,
    name: asString(item.name) ?? id,
    description: asString(item.description) ?? '',
    file,
    type: kind,
    tags: asTags(item.tags)
  };
};

const fromPrompt = (p: Record<string, unknown>): InstalledManifestPrompt | null => {
  const file = asString(p.file);
  if (!file) {
    return null;
  }
  const id = asString(p.id) ?? file;
  return {
    id,
    name: asString(p.name) ?? id,
    description: asString(p.description) ?? '',
    file,
    type: typeof p.type === 'string' ? p.type : 'prompt',
    tags: asTags(p.tags)
  };
};

/**
 * Read a safe normalized view of an installed manifest. Input never mutated.
 * @param manifest
 */
export function readInstalledManifest(manifest: unknown): InstalledManifestDetails {
  if (!isRecord(manifest)) {
    return {};
  }
  const details: InstalledManifestDetails = {};
  const meta = isRecord(manifest.metadata) ? manifest.metadata : undefined;
  details.name = asString(manifest.name);
  details.description = asString(manifest.description) ?? (meta ? asString(meta.description) : undefined);
  let repository = asString(manifest.repository);
  if (!repository && meta) {
    const repoMeta = isRecord(meta.repository) ? asString(meta.repository.url) : asString(meta.repository);
    repository = repoMeta;
  }
  details.repositoryUrl = repository;
  details.homepage = asString(manifest.homepage) ?? (meta ? asString(meta.homepage) : undefined);
  if (Array.isArray(manifest.items)) {
    const prompts = manifest.items
      .filter((i): i is Record<string, unknown> => isRecord(i))
      .map((i) => fromItem(i))
      .filter((p): p is InstalledManifestPrompt => p !== null);
    // formatVersion 1: canonical items are authoritative even when empty.
    if (manifest.formatVersion === 1 || prompts.length > 0) {
      details.prompts = prompts;
    }
  } else if (manifest.formatVersion === 1) {
    // Versioned releases never fall back to compatibility prompts.
    details.prompts = [];
  }
  if (details.prompts === undefined && Array.isArray(manifest.prompts)) {
    details.prompts = manifest.prompts
      .filter((p): p is Record<string, unknown> => isRecord(p))
      .map((p) => fromPrompt(p))
      .filter((p): p is InstalledManifestPrompt => p !== null);
  }
  if (isRecord(manifest.mcpServers)) {
    details.mcpServers = manifest.mcpServers;
  }
  return details;
}
