/**
 * Source ID Normalization Migration.
 * `@migration-cleanup(sourceId-normalization-v2)`: Remove entire file once all lockfiles are migrated
 *
 * Source ID Normalization Migration (sourceId-normalization-v2)
 *
 * Migrates local data (config.json sources, source cache files, installation records)
 * from legacy source IDs (host-only lowercase) to v2 source IDs (full URL lowercase).
 *
 * Lockfiles are NOT rewritten here -- they are Git-committed and shared across teams.
 * Lockfile entries migrate organically when bundles are installed/updated.
 * Dual-read fallback in RepositoryActivationService and RegistryManager handles the gap.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import {
  MigrationRegistry,
} from '../services/migration-registry';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  Logger,
} from '../utils/logger';
import {
  generateHubSourceId,
  generateLegacyHubSourceId,
} from '../utils/source-id-utils';

const rename = promisify(fs.rename);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const readdir = promisify(fs.readdir);

export const MIGRATION_NAME = 'sourceId-normalization-v2';

/**
 * Run the source ID normalization migration.
 * Idempotent: uses MigrationRegistry to ensure it only runs once.
 * @param storage
 * @param migrationRegistry
 */
export async function runSourceIdNormalizationMigration(
    storage: RegistryStorage,
    migrationRegistry: MigrationRegistry
): Promise<void> {
  await migrationRegistry.runMigration(MIGRATION_NAME, async () => {
    const logger = Logger.getInstance();
    const paths = storage.getPaths();

    // Step 1: Migrate config.json sources
    const idMap = await migrateConfigSources(storage, logger);

    if (idMap.size === 0) {
      logger.info('No sources require ID migration');
      return;
    }

    logger.info(`Migrating ${idMap.size} source ID(s): ${[...idMap.entries()].map(([o, n]) => `${o} -> ${n}`).join(', ')}`);

    // Step 2: Rename source cache files
    await migrateSourceCacheFiles(paths.sourcesCache, idMap, logger);

    // Step 3: Update installation records that reference old sourceIds
    await migrateInstallationRecords(paths.userInstalled, idMap, logger);
    await migrateInstallationRecords(paths.installed, idMap, logger);
  });
}

/**
 * Migrate source IDs in config.json.
 * Returns a map of oldId -> newId for sources that were migrated.
 * @param storage
 * @param logger
 */
async function migrateConfigSources(
    storage: RegistryStorage,
    logger: Logger
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();
  const sources = await storage.getSources();
  let changed = false;

  for (const source of sources) {
    // Only hub-generated IDs (format: {type}-{12hexchars}) need migration
    if (!isHubGeneratedId(source.id)) {
      continue;
    }

    // Compute what the new ID should be
    const newId = generateHubSourceId(source.type, source.url, {
      branch: source.config?.branch,
      collectionsPath: source.config?.collectionsPath
    });

    // If the stored ID differs from the new format, it's a legacy ID
    if (source.id !== newId) {
      // Verify it's actually the legacy form (not some other mismatch)
      const legacyId = generateLegacyHubSourceId(source.type, source.url, {
        branch: source.config?.branch,
        collectionsPath: source.config?.collectionsPath
      });

      if (legacyId && source.id === legacyId) {
        logger.info(`Migrating source '${source.name}': ${source.id} -> ${newId}`);
        idMap.set(source.id, newId);
        source.id = newId;
        changed = true;
      }
    }
  }

  if (changed) {
    // Save the updated config through RegistryStorage
    const config = await storage.loadConfig();
    config.sources = sources;
    await storage.saveConfig(config);
  }

  return idMap;
}

/**
 * Check if a source ID looks like a hub-generated ID (format: {type}-{12hexchars})
 * @param id
 */
function isHubGeneratedId(id: string): boolean {
  return /^[a-z]+-[a-f0-9]{12}$/.test(id);
}

/**
 * Rename source cache files from old sanitized ID to new sanitized ID.
 * @param cacheDir
 * @param idMap
 * @param logger
 */
async function migrateSourceCacheFiles(
    cacheDir: string,
    idMap: Map<string, string>,
    logger: Logger
): Promise<void> {
  for (const [oldId, newId] of idMap) {
    const oldFile = path.join(cacheDir, `${sanitize(oldId)}.json`);
    const newFile = path.join(cacheDir, `${sanitize(newId)}.json`);

    try {
      if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
        await rename(oldFile, newFile);
        logger.debug(`Renamed cache file: ${sanitize(oldId)}.json -> ${sanitize(newId)}.json`);
      }
    } catch (error) {
      logger.warn(`Failed to rename cache file for ${oldId}`, error);
    }
  }
}

/**
 * Update sourceId references in installation record JSON files.
 * @param installDir
 * @param idMap
 * @param logger
 */
async function migrateInstallationRecords(
    installDir: string,
    idMap: Map<string, string>,
    logger: Logger
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(installDir);
  } catch {
    return; // directory doesn't exist
  }

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }

    const filepath = path.join(installDir, file);
    try {
      const data = await readFile(filepath, 'utf8');
      const record = JSON.parse(data);

      if (record.sourceId && idMap.has(record.sourceId)) {
        record.sourceId = idMap.get(record.sourceId);
        await writeFile(filepath, JSON.stringify(record, null, 2), 'utf8');
        logger.debug(`Updated sourceId in installation record: ${file}`);
      }
    } catch (error) {
      logger.warn(`Failed to migrate installation record ${file}`, error);
    }
  }
}

/**
 * Sanitize an ID for filenames (mirrors RegistryStorage.sanitizeFilename logic).
 * @param id
 */
function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').substring(0, 200);
}
