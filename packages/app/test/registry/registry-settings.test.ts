/**
 * Tests for app/registry/registry-settings.ts.
 *
 * Ported behavior coverage from the extension's
 * `RegistryManager.exportSettings`/`importSettings`, translated into
 * example-based Vitest cases now that each is a standalone,
 * port-driven function.
 */
import type {
  ExportedSettings,
  ExportedSettingsConfiguration,
  Profile,
  RegistrySettingsOperations,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  exportRegistrySettings,
  importRegistrySettings,
} from '../../src/registry';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    description: 'Test profile',
    icon: '📦',
    bundles: [],
    active: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  };
}

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'source-1',
    name: 'Source 1',
    type: 'github',
    url: 'https://github.com/owner/repo',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

function makePorts(overrides: Partial<RegistrySettingsOperations> = {}): RegistrySettingsOperations {
  return {
    listSources: async () => [],
    addSource: async () => {},
    getProfiles: async () => [],
    addProfile: async () => {},
    updateProfile: async () => {},
    removeProfile: async () => {},
    clearAll: async () => {},
    getConfiguration: () => ({}),
    updateConfiguration: async () => {},
    ...overrides
  };
}

function makeSettings(overrides: Partial<ExportedSettings> = {}): ExportedSettings {
  return {
    version: '1.0.0',
    exportedAt: '2024-01-01T00:00:00.000Z',
    sources: [],
    profiles: [],
    ...overrides
  };
}

describe('exportRegistrySettings', () => {
  it('serializes sources, profiles, and configuration as JSON by default', async () => {
    const source = makeSource();
    const profile = makeProfile();
    const ports = makePorts({
      listSources: async () => [source],
      getProfiles: async () => [profile],
      getConfiguration: () => ({ autoCheckUpdates: true, installationScope: 'user', enableLogging: false })
    });

    const result = await exportRegistrySettings(ports);
    const parsed = JSON.parse(result) as ExportedSettings;

    expect(parsed.version).toBe('1.0.0');
    expect(parsed.sources).toEqual([source]);
    expect(parsed.profiles).toEqual([profile]);
    expect(parsed.configuration).toEqual({ autoCheckUpdates: true, installationScope: 'user', enableLogging: false });
    expect(parsed.exportedAt).toBeTruthy();
  });

  it('serializes as YAML when requested', async () => {
    const ports = makePorts({ listSources: async () => [makeSource()] });

    const result = await exportRegistrySettings(ports, 'yaml');

    expect(result).toContain('version:');
    expect(result).toContain('sources:');
    expect(() => JSON.parse(result)).toThrow();
  });
});

describe('importRegistrySettings', () => {
  it('throws on invalid JSON', async () => {
    const ports = makePorts();

    await expect(importRegistrySettings(ports, '{not json')).rejects.toThrow('Invalid JSON format');
  });

  it('throws when the version is missing or incompatible', async () => {
    const ports = makePorts();

    await expect(importRegistrySettings(ports, JSON.stringify(makeSettings({ version: '2.0.0' }))))
      .rejects.toThrow('Incompatible settings version: 2.0.0. Expected 1.0.0');
  });

  it('throws when sources or profiles are not arrays', async () => {
    const ports = makePorts();
    const malformed = JSON.stringify({ version: '1.0.0', sources: 'nope', profiles: [] });

    await expect(importRegistrySettings(ports, malformed))
      .rejects.toThrow('Invalid settings format: sources and profiles must be arrays');
  });

  it('clears everything first under the replace strategy', async () => {
    let cleared = false;
    const ports = makePorts({
      clearAll: async () => {
        cleared = true;
      }
    });

    await importRegistrySettings(ports, JSON.stringify(makeSettings()), 'json', 'replace');

    expect(cleared).toBe(true);
  });

  it('does not clear under the merge strategy', async () => {
    let cleared = false;
    const ports = makePorts({
      clearAll: async () => {
        cleared = true;
      }
    });

    await importRegistrySettings(ports, JSON.stringify(makeSettings()));

    expect(cleared).toBe(false);
  });

  it('adds only new sources under the merge strategy, skipping existing ids', async () => {
    const existing = makeSource({ id: 'existing' });
    const incoming = [makeSource({ id: 'existing' }), makeSource({ id: 'new-source' })];
    const added: RegistrySource[] = [];
    const ports = makePorts({
      listSources: async () => [existing],
      addSource: async (source) => {
        added.push(source);
      }
    });

    await importRegistrySettings(ports, JSON.stringify(makeSettings({ sources: incoming })));

    expect(added).toEqual([incoming[1]]);
  });

  it('re-adds every source unconditionally under the replace strategy', async () => {
    const existing = makeSource({ id: 'existing' });
    const incoming = [makeSource({ id: 'existing' })];
    const added: RegistrySource[] = [];
    const ports = makePorts({
      listSources: async () => [existing],
      addSource: async (source) => {
        added.push(source);
      }
    });

    await importRegistrySettings(ports, JSON.stringify(makeSettings({ sources: incoming })), 'json', 'replace');

    expect(added).toEqual(incoming);
  });

  it('logs a warning and continues when adding a source fails', async () => {
    const ports = makePorts({
      addSource: async () => {
        throw new Error('boom');
      }
    });
    const events: string[] = [];

    await importRegistrySettings(
      ports,
      JSON.stringify(makeSettings({ sources: [makeSource({ name: 'Bad Source' })] })),
      'json',
      'merge',
      (event) => events.push(`${event.level}:${event.message}`)
    );

    expect(events).toContain('warn:Failed to import source Bad Source: boom');
  });

  it('resets timestamps and forces imported profiles inactive', async () => {
    const incoming = makeProfile({ id: 'imported', active: true, createdAt: 'old', updatedAt: 'old' });
    let added: Profile | undefined;
    const ports = makePorts({
      addProfile: async (profile) => {
        added = profile;
      }
    });

    await importRegistrySettings(ports, JSON.stringify(makeSettings({ profiles: [incoming] })));

    expect(added?.active).toBe(false);
    expect(added?.createdAt).not.toBe('old');
    expect(added?.updatedAt).not.toBe('old');
  });

  it('skips an existing profile id under the merge strategy', async () => {
    const existing = makeProfile({ id: 'existing' });
    let addCalled = false;
    const ports = makePorts({
      getProfiles: async () => [existing],
      addProfile: async () => {
        addCalled = true;
      }
    });

    await importRegistrySettings(ports, JSON.stringify(makeSettings({ profiles: [existing] })));

    expect(addCalled).toBe(false);
  });

  it('logs a warning and continues when adding a profile fails', async () => {
    const ports = makePorts({
      addProfile: async () => {
        throw new Error('boom');
      }
    });
    const events: string[] = [];

    await importRegistrySettings(
      ports,
      JSON.stringify(makeSettings({ profiles: [makeProfile({ name: 'Bad Profile' })] })),
      'json',
      'merge',
      (event) => events.push(`${event.level}:${event.message}`)
    );

    expect(events).toContain('warn:Failed to import profile Bad Profile: boom');
  });

  it('updates only the configuration keys present in the import', async () => {
    let updates: ExportedSettingsConfiguration | undefined;
    const ports = makePorts({
      updateConfiguration: async (u) => {
        updates = u;
      }
    });

    await importRegistrySettings(ports, JSON.stringify(makeSettings({ configuration: { autoCheckUpdates: true } })));

    expect(updates).toEqual({ autoCheckUpdates: true });
  });

  it('does not call updateConfiguration when no configuration is present', async () => {
    let called = false;
    const ports = makePorts({
      updateConfiguration: async () => {
        called = true;
      }
    });

    await importRegistrySettings(ports, JSON.stringify(makeSettings()));

    expect(called).toBe(false);
  });

  it('round-trips YAML export through import', async () => {
    const exportPorts = makePorts({
      listSources: async () => [makeSource()],
      getProfiles: async () => [makeProfile()]
    });
    const yaml = await exportRegistrySettings(exportPorts, 'yaml');

    const added: RegistrySource[] = [];
    const importPorts = makePorts({
      addSource: async (source) => {
        added.push(source);
      }
    });

    await importRegistrySettings(importPorts, yaml, 'yaml');

    expect(added).toHaveLength(1);
    expect(added[0].id).toBe('source-1');
  });
});
