/**
 * Scope Service Factory
 *
 * Factory for creating appropriate scope services based on InstallationScope.
 * Returns UserScopeService for user/workspace scopes and RepositoryScopeService for repository scope.
 *
 * Requirements: 1.1, 1.8, 2.5
 */

import * as vscode from 'vscode';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  InstallationScope,
} from '../types/registry';
import {
  RepositoryScopeService,
} from './repository-scope-service';
import {
  IScopeService,
} from './scope-service';
import {
  UserScopeService,
} from './user-scope-service';

/**
 * Factory for creating scope-specific services.
 *
 * This factory abstracts the creation of scope services, allowing the rest of the
 * codebase to work with the IScopeService interface without knowing the concrete
 * implementation details.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API property name
export const ScopeServiceFactory = {
  /**
   * Create a scope service for the given installation scope.
   * @param scope - The installation scope (user, workspace, or repository)
   * @param context - VS Code extension context (required for user/workspace scopes)
   * @param workspaceRoot - The workspace root path (required for repository scope)
   * @param storage - Registry storage instance (required for repository scope)
   * @returns An IScopeService implementation appropriate for the scope
   * @throws {Error} if scope is unknown or required parameters are missing
   */
  create: (
    scope: InstallationScope,
    context: vscode.ExtensionContext,
    workspaceRoot?: string,
    storage?: RegistryStorage
  ): IScopeService => {
    switch (scope) {
      case 'user':
      case 'workspace': {
        // Both user and workspace scopes use UserScopeService
        // The service handles the distinction internally based on VS Code's profile system
        return new UserScopeService(context);
      }

      case 'repository': {
        // Repository scope requires workspaceRoot and storage
        if (!workspaceRoot) {
          throw new Error('workspaceRoot is required for repository scope');
        }
        if (!storage) {
          throw new Error('storage is required for repository scope');
        }
        return new RepositoryScopeService(workspaceRoot, storage);
      }

      default: {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- value is safely stringifiable at runtime
        throw new Error(`Unknown installation scope: ${scope}`);
      }
    }
  }
};
