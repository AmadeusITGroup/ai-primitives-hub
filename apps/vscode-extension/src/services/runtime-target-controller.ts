/**
 * RuntimeTargetController — thin delegation to the shared application
 * RuntimeTargetSession. Holds no durable state, no host detection, no
 * ExtensionContext coupling. Every public action obtains a fresh session
 * from the injected factory.
 * @module services/runtime-target-controller
 */
import type {
  RuntimeTargetSession,
} from '@ai-primitives-hub/app';
import type {
  RuntimeActiveTarget,
  RuntimeApplyResult,
  RuntimeAvailableCollection,
  RuntimeImportedCollection,
  RuntimeInstalledCollection,
  RuntimeMultiTargetLockfile,
  RuntimeOperation,
  RuntimeProjectionPlan,
  RuntimeTargetCatalogEntry,
  RuntimeTargetSelectionInput,
  RuntimeVerification,
} from '@ai-primitives-hub/core';

export type RuntimeTargetSessionFactory = (workspaceRoot?: string) => RuntimeTargetSession;

export interface RuntimeTargetControllerOptions {
  sessionFactory: RuntimeTargetSessionFactory;
}

/**
 * Thin controller — delegates every call to the app session built for the
 * given workspace root (undefined = user-default/global session).
 */
export class RuntimeTargetController {
  public constructor(private readonly opts: RuntimeTargetControllerOptions) {}

  private session(root?: string): RuntimeTargetSession {
    return this.opts.sessionFactory(root);
  }

  public listTargets(root?: string): Promise<RuntimeTargetCatalogEntry[]> {
    return this.session(root).listTargets();
  }

  public getActiveTarget(root?: string): Promise<RuntimeActiveTarget | undefined> {
    return this.session(root).getActiveTarget();
  }

  public selectTarget(input: RuntimeTargetSelectionInput, root?: string): Promise<RuntimeActiveTarget> {
    return this.session(root).selectTarget(input);
  }

  public listInstalled(root?: string, scope?: 'user' | 'repository'): Promise<RuntimeInstalledCollection[]> {
    const s = this.session(root);
    return (scope === undefined ? s : s.forScope(scope)).listInstalled();
  }

  /**
   * Installations (opaque IDs + instance scope/root) for one or both scopes.
   * @param root
   * @param scope
   */
  public listInstallations(root?: string, scope?: 'user' | 'repository') {
    const s = this.session(root);
    return (scope === undefined ? s : s.forScope(scope)).listInstallations();
  }

  public listAvailableCollections(root?: string): Promise<RuntimeAvailableCollection[]> {
    return this.session(root).listAvailableCollections();
  }

  public importInstalled(input: RuntimeImportedCollection, root?: string): Promise<RuntimeAvailableCollection> {
    return this.session(root).importInstalled(input);
  }

  public plan(op: RuntimeOperation, root?: string, invocation?: { scope: 'user' | 'repository'; path?: string; commitMode?: 'commit' | 'local-only' }): Promise<RuntimeProjectionPlan> {
    const s = this.session(root);
    return (invocation === undefined ? s : s.forScope(invocation.scope, { path: invocation.path, commitMode: invocation.commitMode })).plan(op);
  }

  public apply(op: RuntimeOperation, hash: string, root?: string, invocation?: { scope: 'user' | 'repository'; path?: string; commitMode?: 'commit' | 'local-only' }): Promise<RuntimeApplyResult> {
    const s = this.session(root);
    return (invocation === undefined ? s : s.forScope(invocation.scope, { path: invocation.path, commitMode: invocation.commitMode })).apply(op, hash);
  }

  public verify(root?: string, scope?: 'user' | 'repository'): Promise<RuntimeVerification[]> {
    const s = this.session(root);
    return (scope === undefined ? s : s.forScope(scope)).verify();
  }

  public getLockfile(root?: string): Promise<RuntimeMultiTargetLockfile | null> {
    return this.session(root).getLockfile();
  }
}
