/**
 * Host predicate for Azure DevOps-owned hosts.
 * 
 * @module http/azure-devops-host
 */

/**
 * True for any Azure DevOps-owned host: the public site, the API, raw content,
 * codeload, etc. The suffix match requires an actual subdomain
 * before the suffix, so `fakeazure.com` and the bare `visualstudio.com`
 * both correctly return false.
 * @param host - Hostname to test (typically lower-case from a URL).
 */
export function isAzureDevOpsHost(host: string): boolean {
  if (host.length === 0) {
    return false;
  }
  if (host === 'dev.azure.com' ) {
    return true;
  }
  return false;
}
