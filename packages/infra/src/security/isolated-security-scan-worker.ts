import {
  parentPort,
} from 'node:worker_threads';
import {
  RuleBasedSecurityScanEngine,
  type SecurityDocument,
  type SecurityEngineOptions,
  type SecurityFinding,
} from '@ai-primitives-hub/core';

interface WorkerRequest {
  document: SecurityDocument;
  options: SecurityEngineOptions;
}

if (parentPort === null) {
  throw new Error('Security scan worker requires a parent port');
}

parentPort.on('message', async ({ document, options }: WorkerRequest) => {
  try {
    const engine = new RuleBasedSecurityScanEngine();
    const cancellation = { cancelled: false, throwIfCancelled: (): void => undefined };
    const findings = await engine.scanDocument(document, options, cancellation);
    parentPort?.postMessage({ findings });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});

export type SecurityWorkerResult = { findings: readonly SecurityFinding[] } | { error: string };
