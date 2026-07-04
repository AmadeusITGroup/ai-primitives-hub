// Temporary guard for the extension/CLI migration path.
// @migration-cleanup(extension-cli-migration): Remove once BundleInstaller,
// RegistryManager, UserScopeService, and RepositoryScopeService delegate to
// the shared application use cases without dual-backend fallback paths.
export const EXTENSION_CLI_MIGRATION_GUARD = 'extension-cli-migration';
