import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {requestJSON, SafeError} from './http.mjs';

function existingConfig(env) {
  const homes = [env.HOME, env.USERPROFILE, os.homedir(), os.userInfo().homedir,
    ...[env.CODEX_HOME].filter(Boolean).map(p => path.dirname(p))];
  const candidates = [env.AI_SNAKE_SSH_CONFIG, ...homes.filter(Boolean).map(home => path.join(home, '.ssh/config'))].filter(Boolean);
  for (const file of [...new Set(candidates)]) {
    try {
      if (fs.readFileSync(file, 'utf8').split(/\r?\n/).some(line => {
        const fields = line.trim().split(/\s+/);
        return fields[0]?.toLowerCase() === 'host' && fields.slice(1).includes('ollama-desktop');
      })) return path.resolve(file);
    } catch { /* Use only existing, readable configuration. */ }
  }
  throw new SafeError('本机 Ollama 不通，且没有可读的 ollama-desktop SSH 配置', 'OLLAMA_SSH_CONFIG');
}

/** JSON goes ONLY to stdin. No prompt, model output or credential enters a shell argument or log. */
export function sshOllamaJSON(config, route, body, {signal, timeoutMs = 55000, spawnImpl = spawn, active = new Map()} = {}) {
  if (signal?.aborted) return Promise.reject(new SafeError('Ollama SSH 请求已取消', 'CANCELLED'));
  const seconds = Math.max(1, Math.ceil(Math.min(timeoutMs, 55000) / 1000));
  const command = `curl.exe --silent --show-error --fail --max-time ${seconds} ` +
    (body === undefined ? '' : "--request POST --header 'Content-Type: application/json' --data-binary '@-' ") +
    `http://127.0.0.1:11434${route}`;
  const args = ['-F', config, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=yes', 'ollama-desktop', command];
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, size = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child?.kill('SIGTERM'); reject(error); } else resolve(value);
    };
    const abort = () => finish(new SafeError('Ollama SSH 请求已取消', 'CANCELLED'));
    try { child = spawnImpl('ssh', args, {stdio: ['pipe', 'pipe', 'pipe']}); }
    catch { finish(new SafeError('Ollama SSH 启动失败', 'OLLAMA_SSH')); return; }
    const stopped = new Promise(resolveStop => child.once('close', resolveStop));
    active.set(child, stopped);
    child.once('close', code => {
      active.delete(child);
      if (settled) return;
      if (code !== 0) { finish(new SafeError('Ollama SSH 请求失败', 'OLLAMA_SSH')); return; }
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new SafeError('Ollama SSH 返回了无效 JSON', 'JSON')); }
    });
    child.once('error', () => finish(new SafeError('Ollama SSH 连接失败', 'OLLAMA_SSH')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) finish(new SafeError('Ollama SSH 返回超出大小限制', 'MODEL_SIZE'));
      else chunks.push(chunk);
    });
    child.stderr.resume(); // Never surface remote stderr or provider response bodies.
    child.stdin.once('error', () => finish(new SafeError('Ollama SSH 输入失败', 'OLLAMA_SSH')));
    signal?.addEventListener('abort', abort, {once: true});
    timer = setTimeout(() => finish(new SafeError('Ollama SSH 请求超时', 'TIMEOUT')), Math.min(55000, Math.max(1, timeoutMs)));
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Legacy export name retained for callers. Uses SSH exec, never a persistent TCP tunnel. */
export async function ensureOllamaTunnel(provider, {env = process.env, signal, fetchImpl, spawnImpl = spawn} = {}) {
  const direct = {provider, forwarded: false, transport: 'http', close: async () => {}};
  const host = new URL(provider.baseUrl).hostname;
  if (provider.provider !== 'ollama' || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return direct;
  try {
    await requestJSON(`${provider.baseUrl}/api/tags`, {fetchImpl, signal, timeoutMs: 1500, label: 'Ollama probe'});
    return direct;
  } catch { /* The authorized desktop alias is the only fallback. */ }
  if (signal?.aborted) throw new SafeError('Ollama 连接已取消', 'CANCELLED');
  const config = existingConfig(env), active = new Map();
  const onExit = () => { for (const child of active.keys()) child.kill('SIGTERM'); };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true; process.removeListener('exit', onExit);
    const stopped = [...active.values()]; onExit();
    let timer;
    await Promise.race([Promise.allSettled(stopped), new Promise(resolve => {
      timer = setTimeout(() => { for (const child of active.keys()) child.kill('SIGKILL'); resolve(); }, 1000);
    })]);
    clearTimeout(timer);
  };
  process.once('exit', onExit);
  try {
    await sshOllamaJSON(config, '/api/tags', undefined, {signal, timeoutMs: 12000, spawnImpl, active});
    const connected = {...provider, transport: 'ssh-exec', sshConfig: config, alias: 'ollama-desktop'};
    Object.defineProperty(connected, 'requestJSON', {enumerable: false, value: (body, options = {}) => {
      if (closed) throw new SafeError('Ollama SSH 连接已关闭', 'CANCELLED');
      return sshOllamaJSON(config, '/api/chat', body, {spawnImpl, active, ...options});
    }});
    return {provider: connected, forwarded: false, transport: 'ssh-exec', sshConfig: config, alias: 'ollama-desktop', close};
  } catch (error) { await close(); throw error; }
}

export const ensureOllamaConnection = ensureOllamaTunnel;
