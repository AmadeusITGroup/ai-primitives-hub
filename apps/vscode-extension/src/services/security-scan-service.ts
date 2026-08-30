import {
  runSecurityScan,
  type SecurityScanResult,
} from '@ai-primitives-hub/app';
import type {
  SecurityCancellation,
  SecuritySeverity,
} from '@ai-primitives-hub/core';
import {
  RuleBasedSecurityScanEngine,
} from '@ai-primitives-hub/core';
import {
  NodeSecurityScanInput,
  SECURITY_DEFAULT_LIMITS,
  SystemClock,
} from '@ai-primitives-hub/infra';
import {
  Logger,
} from '../utils/logger';

export interface SecurityScanServiceOptions {
  minimumSeverity?: SecuritySeverity;
  includeLlmControls?: boolean;
  showInfoControls?: boolean;
  ignoreTrust?: 'repository' | 'none' | 'baseline';
}

type MutableCancellation = SecurityCancellation & { cancelled: boolean };

const createCancellation = (): MutableCancellation => ({
  cancelled: false,
  throwIfCancelled(): void {
    if (this.cancelled) throw new Error('Security scan cancelled');
  }
});

export class SecurityScanService {
  private readonly logger = Logger.getInstance();
  private lastResult?: SecurityScanResult;
  private readonly activeScans = new Map<string, MutableCancellation>();

  public getLastResult(): SecurityScanResult | undefined {
    return this.lastResult;
  }

  public scanFile(filePath: string, options: SecurityScanServiceOptions = {}): Promise<SecurityScanResult> {
    return this.scan(`file:${filePath}`, [filePath], options);
  }

  public scanWorkspace(root: string, options: SecurityScanServiceOptions = {}): Promise<SecurityScanResult> {
    return this.scan(`workspace:${root}`, [root], options);
  }

  private async scan(key: string, roots: readonly string[], options: SecurityScanServiceOptions): Promise<SecurityScanResult> {
    const previous = this.activeScans.get(key);
    if (previous !== undefined) previous.cancelled = true;
    const cancellation = createCancellation();
    this.activeScans.set(key, cancellation);
    const engine = new RuleBasedSecurityScanEngine();
    const minimumSeverity = options.minimumSeverity;
    const severities: SecuritySeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
    const selectedSeverities = minimumSeverity === undefined
      ? undefined
      : severities.slice(0, severities.indexOf(minimumSeverity) + 1);
    try {
      const result = await runSecurityScan({
        input: new NodeSecurityScanInput(),
        engine,
        clock: new SystemClock(),
        cancellation,
        request: {
          roots,
          extensions: ['.md', '.markdown'],
          recursive: true,
          excludes: ['.git', 'node_modules'],
          includeDocFiles: false,
          ignoreTrust: options.ignoreTrust ?? 'repository'
        },
        scanOptions: {
          includeLlmControls: options.includeLlmControls ?? false,
          skipInfoControls: !(options.showInfoControls ?? true),
          selectedSeverities
        },
        failOn: 'none',
        limits: SECURITY_DEFAULT_LIMITS
      });
      if (this.activeScans.get(key) === cancellation) this.lastResult = result;
      this.logger.info(`Security scan completed: ${String(result.findings.length)} finding(s), ${String(result.coverage.scanned.length)} file(s)`);
      return result;
    } finally {
      if (this.activeScans.get(key) === cancellation) this.activeScans.delete(key);
    }
  }
}
