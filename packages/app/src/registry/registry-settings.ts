/**
 * Export/import the extension's complete registry settings (sources +
 * profiles + configuration) — ported from
 * `src/services/registry-manager.ts`'s `exportSettings`/
 * `importSettings`. Part of the `RegistryManager` scoping pass's
 * slice 6 (migration plan §7.5 item 3).
 * @module registry/registry-settings
 */
import type {
  ExportedSettings,
  ExportFormat,
  ImportStrategy,
  RegistrySettingsOperations,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

const SETTINGS_SCHEMA_VERSION = '1.0.0';

function log(onLog: OnLogEvent | undefined, level: LogEvent['level'], message: string, error?: Error): void {
  onLog?.({ level, message, error });
}

/**
 * Serialize every source, profile, and the 3 tracked configuration
 * keys as JSON or YAML.
 * @param ports Registry read access.
 * @param format Output format (defaults to `'json'`).
 * @returns The serialized settings.
 */
export async function exportRegistrySettings(
  ports: RegistrySettingsOperations,
  format: ExportFormat = 'json'
): Promise<string> {
  const sources = await ports.listSources();
  const profiles = await ports.getProfiles();

  const settings: ExportedSettings = {
    version: SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sources,
    profiles,
    configuration: ports.getConfiguration()
  };

  if (format === 'yaml') {
    const yaml = await import('js-yaml');
    return yaml.default.dump(settings, {
      indent: 2,
      lineWidth: 120,
      noRefs: true
    });
  }

  return JSON.stringify(settings, null, 2);
}

/**
 * Import sources, profiles, and configuration from a previously
 * exported JSON/YAML string. Per-item failures are logged and
 * skipped rather than aborting the whole import (matches the
 * original's own resilience).
 * @param ports Registry read/write access.
 * @param data Serialized settings.
 * @param format Input format (defaults to `'json'`).
 * @param strategy `'merge'` skips existing ids, `'replace'` wipes
 * everything first and overwrites unconditionally (defaults to `'merge'`).
 * @param onLog Optional sink for diagnostic log events.
 */
export async function importRegistrySettings(
  ports: RegistrySettingsOperations,
  data: string,
  format: ExportFormat = 'json',
  strategy: ImportStrategy = 'merge',
  onLog?: OnLogEvent
): Promise<void> {
  let settings: ExportedSettings;
  try {
    if (format === 'yaml') {
      const yaml = await import('js-yaml');
      settings = yaml.default.load(data) as ExportedSettings;
    } else {
      settings = JSON.parse(data) as ExportedSettings;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${format.toUpperCase()} format: ${message}`);
  }

  if (!settings.version || settings.version !== SETTINGS_SCHEMA_VERSION) {
    throw new Error(`Incompatible settings version: ${settings.version || 'unknown'}. Expected ${SETTINGS_SCHEMA_VERSION}`);
  }

  if (!Array.isArray(settings.sources) || !Array.isArray(settings.profiles)) {
    throw new Error('Invalid settings format: sources and profiles must be arrays');
  }

  if (strategy === 'replace') {
    await ports.clearAll();
  }

  for (const source of settings.sources) {
    try {
      const existingSources = await ports.listSources();
      const existing = existingSources.find((s) => s.id === source.id);

      if (!existing || strategy === 'replace') {
        await ports.addSource(source);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(onLog, 'warn', `Failed to import source ${source.name}: ${message}`);
    }
  }

  for (const profile of settings.profiles) {
    try {
      const existingProfiles = await ports.getProfiles();
      const existing = existingProfiles.find((p) => p.id === profile.id);

      if (!existing || strategy === 'replace') {
        profile.createdAt = new Date().toISOString();
        profile.updatedAt = new Date().toISOString();
        profile.active = false;

        await ports.addProfile(profile);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(onLog, 'warn', `Failed to import profile ${profile.name}: ${message}`);
    }
  }

  if (settings.configuration) {
    const updates = {
      ...(settings.configuration.autoCheckUpdates !== undefined && { autoCheckUpdates: settings.configuration.autoCheckUpdates }),
      ...(settings.configuration.installationScope !== undefined && { installationScope: settings.configuration.installationScope }),
      ...(settings.configuration.enableLogging !== undefined && { enableLogging: settings.configuration.enableLogging })
    };

    if (Object.keys(updates).length > 0) {
      await ports.updateConfiguration(updates);
    }
  }
}
