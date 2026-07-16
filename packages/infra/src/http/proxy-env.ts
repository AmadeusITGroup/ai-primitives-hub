/**
 * Proxy environment inspection.
 *
 * Node's `globalThis.fetch` (undici) and `NodeHttpClient` do not
 * automatically honour the standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
 * environment variables. This module only reports what proxy configuration
 * is present (env vars + git config fallback) — used by `doctor`'s
 * network-config check to help users diagnose connectivity issues. It does
 * not wire proxy support into `NodeHttpClient` itself (out of scope here).
 * @module http/proxy-env
 */
import {
  execSync,
} from 'node:child_process';

/**
 * Read `http.proxy` and `https.proxy` from git config.
 *
 * The `gh` CLI uses git config as a fallback for proxy settings. We do the
 * same so users who configure proxies via `git config --global http.proxy`
 * don't need to also set env vars.
 * @returns Object with `httpProxy` and `httpsProxy` from git config, or undefined.
 */
export const readGitProxyConfig = (): {
  httpProxy?: string;
  httpsProxy?: string;
} => {
  const readConfig = (key: string): string | undefined => {
    try {
      const output = execSync(`git config --get ${key}`, {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      return output.length > 0 ? output : undefined;
    } catch {
      return undefined;
    }
  };
  const httpProxy = readConfig('http.proxy');
  const httpsProxy = readConfig('https.proxy');
  const result: { httpProxy?: string; httpsProxy?: string } = {};
  if (httpProxy !== undefined) {
    result.httpProxy = httpProxy;
  }
  if (httpsProxy !== undefined) {
    result.httpsProxy = httpsProxy;
  }
  return result;
};

/**
 * Check whether any proxy-relevant env var is configured.
 * @param env Environment bag.
 * @returns True if at least one proxy-related variable is present.
 */
export const hasProxyEnv = (
  env: Record<string, string | undefined>
): boolean => {
  const keys = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'no_proxy'
  ];
  return keys.some((k) => {
    const v = env[k];
    return v !== undefined && v.length > 0;
  });
};

/**
 * Build a human-readable summary of the proxy configuration present in the
 * environment. Useful for diagnostics — never prints secrets.
 * Also checks `git config http.proxy` / `https.proxy` as a fallback.
 * @param env Environment bag.
 * @returns Object describing which proxy env vars were found.
 */
export const summarizeProxyEnv = (
  env: Record<string, string | undefined>
): {
  configured: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  source?: 'env' | 'git-config' | 'both';
} => {
  const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  const envConfigured = hasProxyEnv(env);
  const gitProxy = readGitProxyConfig();
  const gitConfigured = gitProxy.httpProxy !== undefined || gitProxy.httpsProxy !== undefined;
  const summary: {
    configured: boolean;
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
    source?: 'env' | 'git-config' | 'both';
  } = {
    configured: envConfigured || gitConfigured
  };
  if (httpProxy !== undefined && httpProxy.length > 0) {
    summary.httpProxy = httpProxy;
  }
  if (httpsProxy !== undefined && httpsProxy.length > 0) {
    summary.httpsProxy = httpsProxy;
  }
  if (noProxy !== undefined && noProxy.length > 0) {
    summary.noProxy = noProxy;
  }
  if (envConfigured && gitConfigured) {
    summary.source = 'both';
  } else if (envConfigured) {
    summary.source = 'env';
  } else if (gitConfigured) {
    summary.source = 'git-config';
  }
  return summary;
};
