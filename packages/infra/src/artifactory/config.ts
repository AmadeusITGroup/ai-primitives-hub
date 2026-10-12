import {
  RegistryError,
  type RegistrySource,
} from '@ai-primitives-hub/core';
import {
  normalizeSourceRoot,
} from './published-object-url';

export interface ArtifactorySourceConfig { indexFile?: string; authMode?: 'anonymous' | 'bearer'; credentialRef?: string }

/**
 * Parse and validate the small Artifactory-specific source configuration.
 * @param source Configured source.
 */
export function parseArtifactorySourceConfig(source: RegistrySource): ArtifactorySourceConfig {
  try {
    normalizeSourceRoot(source.url);
  } catch (cause) {
    throw new RegistryError({ code: 'ARTIFACTORY.CONFIG_INVALID', message: 'Invalid Artifactory source configuration.', cause });
  }
  const config = source.config ?? {};
  for (const key of ['token', 'password', 'secret', 'apiKey', 'accessToken']) {
    if (key in config) {
      throw new RegistryError({ code: 'ARTIFACTORY.CONFIG_INVALID', message: 'Artifactory configuration must not contain secret values.' });
    }
  }
  const indexFile = typeof config.indexFile === 'string' && config.indexFile.length > 0 ? config.indexFile : 'index-v1.json';
  if (indexFile.startsWith('/') || indexFile.includes('\\') || indexFile.includes('..') || indexFile.includes('%')) {
    throw new RegistryError({ code: 'ARTIFACTORY.CONFIG_INVALID', message: 'Artifactory indexFile must be a confined relative path.' });
  }
  const authMode = config.authMode === 'bearer' ? 'bearer' : 'anonymous';
  if (source.private === true && authMode !== 'bearer') {
    throw new RegistryError({ code: 'ARTIFACTORY.CONFIG_INVALID', message: 'Private Artifactory sources require Bearer authentication.' });
  }
  return { indexFile, authMode, credentialRef: typeof config.credentialRef === 'string' ? config.credentialRef : undefined };
}
