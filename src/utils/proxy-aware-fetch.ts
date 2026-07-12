/**
 * Proxy-aware fetch factory.
 *
 * Node's `globalThis.fetch` (undici) does not automatically honour the
 * standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` environment variables in
 * all versions. This module wraps undici's `EnvHttpProxyAgent` so the same
 * fetch path respects those variables.
 *
 * Author: Waldek Herka
 */

export type FetchLike = (req: Request) => Promise<Response>;

/**
 * Create a fetch implementation that respects the standard proxy env vars.
 *
 * Reads `HTTP_PROXY`/`http_proxy`, `HTTPS_PROXY`/`https_proxy`, and
 * `NO_PROXY`/`no_proxy` from the provided env bag. When any of these is set,
 * undici routes requests through the matching proxy. When none are set, the
 * returned fetch is equivalent to `globalThis.fetch`.
 * @param env Environment bag. Defaults to `process.env`.
 * @returns A fetch function that can be passed to HTTP clients.
 */
export const createProxyAwareFetch = (
  env: Record<string, string | undefined> = process.env
): FetchLike => {
  if (!hasProxyEnv(env)) {
    return (req: Request): Promise<Response> => fetch(req);
  }

  return async (req: Request): Promise<Response> => {
    const { EnvHttpProxyAgent } = await import('undici');
    const agent = new EnvHttpProxyAgent({
      httpProxy: env.HTTP_PROXY ?? env.http_proxy,
      httpsProxy: env.HTTPS_PROXY ?? env.https_proxy,
      noProxy: env.NO_PROXY ?? env.no_proxy
    });
    return fetch(req, { dispatcher: agent } as Record<string, unknown>);
  };
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
} => {
  const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  return {
    configured: hasProxyEnv(env),
    ...(httpProxy !== undefined && httpProxy.length > 0 ? { httpProxy } : {}),
    ...(httpsProxy !== undefined && httpsProxy.length > 0 ? { httpsProxy } : {}),
    ...(noProxy !== undefined && noProxy.length > 0 ? { noProxy } : {})
  };
};
