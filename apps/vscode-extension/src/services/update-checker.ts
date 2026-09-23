/**
 * Update Checker Service
 * Performs update detection by comparing installed versions with latest available versions
 * Wraps RegistryManager.checkUpdates() with caching and auto-update enrichment
 *
 * Thin wrapper around `@ai-primitives-hub/app`'s `UpdateCheckerCore` (the
 * strangler-fig-ported orchestration logic) — adapts this extension's
 * `RegistryManager`/`RegistryStorage`/`vscode.Memento`-backed `UpdateCache`
 * to the port shapes `UpdateCheckerCore` depends on, and forwards its
 * generic log events to the extension's own `Logger`. See ADR-0005
 */

import {
  UpdateCheckerCore,
} from '@ai-primitives-hub/app';
import type {
  LogEvent,
} from '@ai-primitives-hub/app';
import * as vscode from 'vscode';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  Logger,
} from '../utils/logger';
import {
  RegistryManager,
} from './registry-manager';
import {
  UpdateCache,
  UpdateCheckResult,
} from './update-cache';

/**
 * Update checker service
 * Orchestrates update checking with caching and preference enrichment
 */
export class UpdateChecker {
  private readonly core: UpdateCheckerCore;

  constructor(
    private readonly registryManager: RegistryManager,
    private readonly storage: RegistryStorage,
    memento: vscode.Memento
  ) {
    const cache = new UpdateCache(memento);
    const logger = Logger.getInstance();

    this.core = new UpdateCheckerCore({
      registry: registryManager,
      preferences: storage,
      cache: {
        get: () => cache.get(),
        set: (results) => cache.set(results),
        isValid: () => cache.isValid()
      },
      onLog: (event: LogEvent) => this.forwardLogEvent(logger, event)
    });
  }

  private forwardLogEvent(logger: Logger, event: LogEvent): void {
    switch (event.level) {
      case 'debug': {
        logger.debug(event.message, event.error);
        break;
      }
      case 'info': {
        logger.info(event.message);
        break;
      }
      case 'warn': {
        logger.warn(event.message, event.error);
        break;
      }
      case 'error': {
        logger.error(event.message, event.error);
        break;
      }
    }
  }

  /**
   * Check all installed bundles for updates
   * Uses cache if available and valid, otherwise queries RegistryManager
   * Enriches results with auto-update preferences
   * @param bypassCache
   * @param syncSources
   */
  public async checkForUpdates(bypassCache = false, syncSources = true): Promise<UpdateCheckResult[]> {
    return this.core.checkForUpdates(bypassCache, syncSources);
  }

  /**
   * Get cached update results without triggering a new check
   */
  public async getCachedResults(): Promise<UpdateCheckResult[] | null> {
    return this.core.getCachedResults();
  }
}
