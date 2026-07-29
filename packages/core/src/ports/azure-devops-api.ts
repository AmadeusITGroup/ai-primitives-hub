/**
 * AzureDevOpsApi port — interface for Azure DevOps REST API interactions.
 *
 * Mirrors the `GitHubApi` port shape so adapters are structurally
 * consistent. Implementation lives in `@ai-primitives-hub/infra`.
 * @module ports/azure-devops-api
 */

/**
 * Minimal HTTP client port for the Azure DevOps REST API.
 */
export interface AzureDevOpsApi {
  /** Fetch a JSON response from an ADO REST API path or absolute URL. */
  getJson<T>(pathOrUrl: string): Promise<T>;
  /** Fetch a plain-text response (e.g. raw file content). */
  getText(pathOrUrl: string): Promise<string>;
  /** Download binary content as a Uint8Array. */
  download(pathOrUrl: string): Promise<Uint8Array>;
}
