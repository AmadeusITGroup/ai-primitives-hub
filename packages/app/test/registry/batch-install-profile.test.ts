/**
 * Tests for registry/batch-install-profile.ts: installing a hub profile's
 * bundles as ordinary installs, without activating the profile.
 */
import type {
  HubProfileBundle,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  batchInstallProfile,
  type BatchInstallProfilePorts,
  type BatchInstallReport,
} from '../../src/registry/batch-install-profile';

const bundle = (id: string, required: boolean): HubProfileBundle => ({ id, version: '1.0.0', source: 'src', required });

function makePorts(report: BatchInstallReport) {
  const installBundles = vi.fn<BatchInstallProfilePorts['installBundles']>().mockResolvedValue(report);
  const removeBundles = vi.fn<BatchInstallProfilePorts['removeBundles']>().mockResolvedValue(undefined);
  const ports: BatchInstallProfilePorts = { installBundles, removeBundles };
  return { ports, installBundles, removeBundles };
}

describe('batchInstallProfile', () => {
  it('installs every profile bundle and reports new and already-present ones', async () => {
    const { ports, installBundles, removeBundles } = makePorts({
      installed: [
        { bundleId: 'a', version: '1.0.0', status: 'new' },
        { bundleId: 'b', version: '1.0.0', status: 'unchanged' }
      ],
      failed: []
    });

    const result = await batchInstallProfile(ports, [bundle('a', true), bundle('b', false)]);

    expect(installBundles).toHaveBeenCalledWith([bundle('a', true), bundle('b', false)]);
    expect(result).toEqual({
      success: true,
      installed: [{ bundleId: 'a', version: '1.0.0' }],
      alreadyInstalled: [{ bundleId: 'b', version: '1.0.0' }],
      failed: []
    });
    expect(removeBundles).not.toHaveBeenCalled();
  });

  it('succeeds and reports the failure when only an optional bundle fails', async () => {
    const { ports, removeBundles } = makePorts({
      installed: [{ bundleId: 'a', version: '1.0.0', status: 'new' }],
      failed: [{ bundleId: 'opt', reason: 'source unreachable' }]
    });

    const result = await batchInstallProfile(ports, [bundle('a', true), bundle('opt', false)]);

    expect(result.success).toBe(true);
    expect(result.failed).toEqual([{ bundleId: 'opt', reason: 'source unreachable' }]);
    expect(removeBundles).not.toHaveBeenCalled();
  });

  it('fails and removes only the newly installed bundles when a required bundle is missing', async () => {
    const { ports, removeBundles } = makePorts({
      installed: [
        { bundleId: 'new', version: '1.0.0', status: 'new' },
        { bundleId: 'present', version: '1.0.0', status: 'unchanged' }
      ],
      failed: [{ bundleId: 'req', reason: 'not found' }]
    });

    const result = await batchInstallProfile(ports, [bundle('new', false), bundle('present', true), bundle('req', true)]);

    expect(result.success).toBe(false);
    expect(result.missingRequiredBundles).toEqual(['req']);
    expect(result.error).toContain('req');
    expect(removeBundles).toHaveBeenCalledWith(['new']);
    // Nothing stays installed from this batch.
    expect(result.installed).toEqual([]);
    expect(result.alreadyInstalled).toEqual([{ bundleId: 'present', version: '1.0.0' }]);
  });

  it('still reports the missing required bundles when removing the new ones fails', async () => {
    const { ports, removeBundles } = makePorts({
      installed: [{ bundleId: 'new', version: '1.0.0', status: 'new' }],
      failed: [{ bundleId: 'req', reason: 'not found' }]
    });
    removeBundles.mockRejectedValueOnce(new Error('disk full'));

    const result = await batchInstallProfile(ports, [bundle('new', false), bundle('req', true)]);

    expect(result.success).toBe(false);
    expect(result.missingRequiredBundles).toEqual(['req']);
    expect(result.error).toContain('disk full');
    expect(result.removalError).toBe('disk full');
    // The bundle that could not be removed is still reported as installed.
    expect(result.installed).toEqual([{ bundleId: 'new', version: '1.0.0' }]);
  });

  it('reports an update as installed and keeps it when a required bundle is missing', async () => {
    const { ports, removeBundles } = makePorts({
      installed: [
        { bundleId: 'new', version: '1.0.0', status: 'new' },
        { bundleId: 'upgraded', version: '2.0.0', status: 'updated' }
      ],
      failed: [{ bundleId: 'req', reason: 'not found' }]
    });

    const result = await batchInstallProfile(ports, [bundle('new', false), bundle('upgraded', false), bundle('req', true)]);

    expect(result.success).toBe(false);
    expect(removeBundles).toHaveBeenCalledWith(['new']);
    expect(result.installed).toEqual([{ bundleId: 'upgraded', version: '2.0.0' }]);
  });

  it('still asks the delivery to undo the batch when no bundle was new', async () => {
    const { ports, removeBundles } = makePorts({
      installed: [{ bundleId: 'present', version: '1.0.0', status: 'unchanged' }],
      failed: [{ bundleId: 'req', reason: 'not found' }]
    });

    const result = await batchInstallProfile(ports, [bundle('present', false), bundle('req', true)]);

    expect(result.success).toBe(false);
    expect(removeBundles).toHaveBeenCalledWith([]);
  });

  it('lists updated bundles under installed on success', async () => {
    const { ports } = makePorts({
      installed: [{ bundleId: 'upgraded', version: '2.0.0', status: 'updated' }],
      failed: []
    });

    const result = await batchInstallProfile(ports, [bundle('upgraded', true)]);

    expect(result).toMatchObject({ success: true, installed: [{ bundleId: 'upgraded', version: '2.0.0' }], alreadyInstalled: [] });
  });
});
