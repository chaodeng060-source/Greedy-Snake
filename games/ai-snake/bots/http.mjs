import http from 'node:http';
/** Shared, dependency-free HTTP. Never include response bodies or credentials in errors. */
let proxyInitialized = false;
export function configureProxy(env = process.env) {
  if (typeof http.setGlobalProxyFromEnv !== 'function') return;
  const noProxy = [env.no_proxy || env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
  return http.setGlobalProxyFromEnv({...env, NO_PROXY: noProxy, no_proxy: noProxy});
}
export class SafeError extends Error {
  constructor(message, code = 'ERROR', usage) {
    super(message);
    this.code = code;
    this.usage = usage;
  }
}

export function baseURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new SafeError('需要完整的 http(s) URL', 'CONFIG'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new SafeError('URL 不得包含凭据、查询参数或片段', 'CONFIG');
  return url.href.replace(/\/+$/, '');
}

export async function requestJSON(url, {body, headers, fetchImpl = globalThis.fetch,
  timeoutMs = 10000, signal, label = 'room'} = {}) {
  if (fetchImpl === globalThis.fetch && !proxyInitialized) {
    configureProxy(); proxyInitialized = true;
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
      headers: {'Content-Type': 'application/json', ...headers},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SafeError(`${label} HTTP ${response.status}`, 'HTTP');
    }
    try { return await response.json(); }
    catch { throw new SafeError(`${label} 返回了无效 JSON`, 'JSON'); }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError(`${label} ${combined.aborted ? '请求已取消或超时' : '连接失败'}`,
      combined.aborted ? 'TIMEOUT' : 'NETWORK');
  }
}
