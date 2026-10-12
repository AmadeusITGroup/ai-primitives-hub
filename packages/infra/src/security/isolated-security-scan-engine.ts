import {
  existsSync,
} from 'node:fs';
import * as path from 'node:path';
import {
  Worker,
} from 'node:worker_threads';
import type {
  SecurityCancellation,
  SecurityDocument,
  SecurityEngineCapabilities,
  SecurityEngineDescriptor,
  SecurityEngineOptions,
  SecurityFinding,
  SecurityScanEngine,
} from '@ai-primitives-hub/core';
import type {
  SecurityWorkerResult,
} from './isolated-security-scan-worker';

export class IsolatedSecurityScanEngine implements SecurityScanEngine {
  public constructor(
    private readonly descriptorValue: SecurityEngineDescriptor,
    private readonly capabilitiesValue: SecurityEngineCapabilities,
    private readonly timeoutMs = 2000,
    private readonly fallback?: SecurityScanEngine
  ) {}

  public get descriptor(): SecurityEngineDescriptor {
    return this.descriptorValue;
  }

  public get capabilities(): SecurityEngineCapabilities {
    return this.capabilitiesValue;
  }

  public scanDocument(document: SecurityDocument, options: SecurityEngineOptions, cancellation: SecurityCancellation): Promise<readonly SecurityFinding[]> {
    cancellation.throwIfCancelled();
    const workerPath = path.join(__dirname, 'isolated-security-scan-worker.js');
    if (!existsSync(workerPath)) {
      if (this.fallback === undefined) {
        return Promise.reject(new Error('Security scan worker is not packaged'));
      }
      return this.fallback.scanDocument(document, options, cancellation);
    }
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath);
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearInterval(cancellationTimer);
        void worker.terminate();
        callback();
      };
      const timer = setTimeout(() => finish(() => reject(new Error('SECURITY.LIMIT_EXCEEDED: document evaluation timed out'))), this.timeoutMs);
      const cancellationTimer = setInterval(() => {
        if (cancellation.cancelled) {
          finish(() => reject(new Error('SECURITY.CANCELLED: document evaluation cancelled')));
        }
      }, 10);
      worker.once('error', (error) => finish(() => reject(error)));
      worker.once('message', (message: SecurityWorkerResult) => {
        finish(() => {
          if ('error' in message) {
            reject(new Error(message.error));
          } else {
            resolve(message.findings);
          }
        });
      });
      worker.postMessage({ document, options });
    });
  }
}
