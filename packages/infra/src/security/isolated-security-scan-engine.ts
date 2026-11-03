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
  private worker?: Worker;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(
    private readonly descriptorValue: SecurityEngineDescriptor,
    private readonly capabilitiesValue: SecurityEngineCapabilities,
    private readonly timeoutMs = 2000,
    private readonly workerPath = path.join(__dirname, 'isolated-security-scan-worker.js')
  ) {}

  public get descriptor(): SecurityEngineDescriptor {
    return this.descriptorValue;
  }

  public get capabilities(): SecurityEngineCapabilities {
    return this.capabilitiesValue;
  }

  private evaluate(document: SecurityDocument, options: SecurityEngineOptions, cancellation: SecurityCancellation): Promise<readonly SecurityFinding[]> {
    if (this.disposed) {
      return Promise.reject(new Error('Security scan engine is disposed'));
    }
    cancellation.throwIfCancelled();
    if (!existsSync(this.workerPath)) {
      return Promise.reject(new Error('Security scan worker is not packaged'));
    }
    return new Promise((resolve, reject) => {
      const worker = this.worker ?? new Worker(this.workerPath);
      this.worker = worker;
      let settled = false;
      const finish = (callback: () => void, failed = false): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearInterval(cancellationTimer);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
        worker.removeListener('message', onMessage);
        if (failed) {
          this.worker = undefined;
          void worker.terminate();
        }
        callback();
      };
      const timer = setTimeout(() => finish(() => reject(new Error('SECURITY.LIMIT_EXCEEDED: document evaluation timed out')), true), this.timeoutMs);
      const cancellationTimer = setInterval(() => {
        if (cancellation.cancelled) {
          finish(() => reject(new Error('SECURITY.CANCELLED: document evaluation cancelled')), true);
        }
      }, 10);
      const onError = (error: Error): void => finish(() => reject(error), true);
      const onExit = (code: number): void => finish(() => reject(new Error(`SECURITY.ENGINE_FAILED: scan worker exited without a result (${String(code)})`)), true);
      const onMessage = (message: SecurityWorkerResult): void => {
        finish(() => {
          if ('error' in message) {
            reject(new Error(message.error));
          } else {
            resolve(message.findings);
          }
        }, 'error' in message);
      };
      worker.once('error', onError);
      worker.once('exit', onExit);
      worker.once('message', onMessage);
      worker.postMessage({ document, options });
    });
  }

  public scanDocument(document: SecurityDocument, options: SecurityEngineOptions, cancellation: SecurityCancellation): Promise<readonly SecurityFinding[]> {
    const result = this.queue.then(() => this.evaluate(document, options, cancellation));
    // The caller retains the rejection; later documents may retry with a new worker.
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) {
      await worker.terminate();
    }
  }
}
