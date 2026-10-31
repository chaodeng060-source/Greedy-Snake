import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {baseURL, SafeError} from './http.mjs';

// JSONC without evaluating config, invoking OpenCode, or adding dependencies.
export function parseJSONC(text) {
  let clean = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (quoted) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; clean += c; }
    else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      clean += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; clean += ' ';
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) clean += ' ';
    else clean += c;
  }
  // Remove trailing commas after comments have been stripped, preserving quoted text.
  return JSON.parse(clean.replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (match, string, end) => string ?? end));
}

function readJSON(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    try { return JSON.parse(text); } catch { return parseJSONC(text); }
  } catch { return undefined; }
}

function userHomes(env) {
  const homes = [env.AI_SNAKE_OPENCODE_HOME, env.HOME, env.USERPROFILE, os.homedir(),
    ...[env.CODEX_HOME].filter(Boolean).map(p => path.dirname(p))];
  return [...new Set(homes.filter(Boolean))];
}

function expand(value, env, directory) {
  if (typeof value !== 'string') return undefined;
  const envRef = value.match(/^\{env:([^}]+)\}$/);
  if (envRef) return env[envRef[1]]?.trim();
  const fileRef = value.match(/^\{file:([^}]+)\}$/);
  if (fileRef) {
    const filename = fileRef[1].startsWith('~/') ? path.join(env.HOME || os.homedir(), fileRef[1].slice(2)) : path.resolve(directory, fileRef[1]);
    try { return fs.readFileSync(filename, 'utf8').trim(); } catch { return undefined; }
  }
  return value.trim();
}

/** AI_SNAKE_OPENAI_MODEL 可以写一个，也可以逗号分隔写几个；建房只能选这里列出的。 */
export function openaiModels(env = process.env) {
  return [...new Set((env.AI_SNAKE_OPENAI_MODEL || '').split(',').map(s => s.trim()).filter(Boolean))];
}

/** 服务器开放的自动 AI 通道。AI_SNAKE_PROVIDERS=openai,ollama 这样写可以只开其中几个；manual 总是可用。 */
export function autoProviders(env = process.env) {
  const listed = (env.AI_SNAKE_PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean);
  const all = ['opencode', 'ollama', ...(env.AI_SNAKE_OPENAI_BASE_URL?.trim() ? ['openai'] : [])];
  return listed.length ? all.filter(p => listed.includes(p)) : all;
}

/** Offline resolution only. apiKey is deliberately non-enumerable. */
export function resolveProvider(input = {}, overrides = {}) {
  const options = typeof input === 'string' ? {provider: input, ...overrides} : input;
  const {provider = 'opencode', env = process.env, cwd = process.cwd()} = options;
  const homes = options.homes ?? userHomes(env);
  const configs = [];
  const addConfig = file => {
    const data = readJSON(file);
    if (data) configs.push({data, source: file, directory: path.dirname(file)});
  };
  for (const home of [...homes].reverse()) {
    for (const filename of ['opencode.json', 'opencode.jsonc']) addConfig(path.join(home, '.config/opencode', filename));
  }
  if (env.XDG_CONFIG_HOME) for (const f of ['opencode.json', 'opencode.jsonc']) addConfig(path.join(env.XDG_CONFIG_HOME, 'opencode', f));
  if (env.OPENCODE_CONFIG_DIR) for (const f of ['opencode.json', 'opencode.jsonc']) addConfig(path.join(env.OPENCODE_CONFIG_DIR, f));
  if (env.OPENCODE_CONFIG) addConfig(env.OPENCODE_CONFIG);
  for (const f of ['opencode.json', 'opencode.jsonc']) addConfig(path.join(cwd, f));
  if (env.OPENCODE_CONFIG_CONTENT) {
    try { configs.push({data: parseJSONC(env.OPENCODE_CONFIG_CONTENT), source: 'env:OPENCODE_CONFIG_CONTENT', directory: cwd}); }
    catch { throw new SafeError('OpenCode inline config JSON 无效', 'CONFIG'); }
  }

  const records = [...configs].reverse();
  if (provider === 'ollama') {
    const record = records.find(c => c.data.model?.startsWith('ollama/'));
    const model = options.model || env.AI_SNAKE_OLLAMA_MODEL || env.OLLAMA_MODEL || record?.data.model.slice(7) || 'qwen3:8b';
    const configuredURL = records.map(c => expand(c.data.provider?.ollama?.options?.baseURL, env, c.directory)).find(Boolean);
    const url = env.AI_SNAKE_OLLAMA_URL || env.OLLAMA_URL || env.OLLAMA_HOST || configuredURL || 'http://127.0.0.1:11434';
    return {provider, model: model.replace(/^ollama\//, ''), baseUrl: baseURL(url).replace(/\/(?:v1|api)$/, ''), keySource: 'none (local Ollama)'};
  }
  // 任意 OpenAI 兼容接口（DeepSeek 官方、通义、OpenAI、自建 vLLM……）：地址、钥匙、能用的模型都只从服务器环境变量来。
  if (provider === 'openai') {
    const url = env.AI_SNAKE_OPENAI_BASE_URL?.trim();
    if (!url) throw new SafeError('没有配置 AI_SNAKE_OPENAI_BASE_URL', 'CONFIG');
    const allowed = openaiModels(env);
    const model = options.model || allowed[0];
    if (!model || !allowed.includes(model)) throw new SafeError('模型不在 AI_SNAKE_OPENAI_MODEL 列表里', 'CONFIG');
    const apiKey = env.AI_SNAKE_OPENAI_API_KEY?.trim() || '';
    // 有的接口要额外请求头（OpenCode Go 要 x-opencode-session，OpenRouter 要 HTTP-Referer），JSON 对象写在这里。
    let headers = {};
    if (env.AI_SNAKE_OPENAI_HEADERS?.trim()) {
      try { headers = JSON.parse(env.AI_SNAKE_OPENAI_HEADERS); } catch { throw new SafeError('AI_SNAKE_OPENAI_HEADERS 须为 JSON 对象', 'CONFIG'); }
      if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(v => typeof v !== 'string'))
        throw new SafeError('AI_SNAKE_OPENAI_HEADERS 须为字符串值的 JSON 对象', 'CONFIG');
    }
    const result = {provider, model, baseUrl: baseURL(url).replace(/\/chat\/completions$/, ''),
      keySource: apiKey ? 'env:AI_SNAKE_OPENAI_API_KEY' : 'none',
      jsonMode: env.AI_SNAKE_OPENAI_JSON_MODE !== '0', reasoningEffort: env.AI_SNAKE_OPENAI_REASONING_EFFORT?.trim() || undefined};
    Object.defineProperty(result, 'apiKey', {value: apiKey, enumerable: false});
    Object.defineProperty(result, 'headers', {value: headers, enumerable: false});
    return result;
  }
  if (provider !== 'opencode') throw new SafeError('自动 bot 只支持 opencode、ollama 或 openai', 'CONFIG');

  const goRecords = records.filter(c => c.data.provider?.['opencode-go']);
  const active = records.find(c => c.data.model?.startsWith('opencode-go/deepseek'));
  const configured = goRecords.flatMap(c => Object.keys(c.data.provider['opencode-go'].models || {})).filter(m => m.startsWith('deepseek'));
  const presetModel = options.model || env.AI_SNAKE_OPENCODE_MODEL || env.OPENCODE_GO_MODEL ||
    active?.data.model || configured.find(m => m.includes('flash')) || configured[0];
  const catalogs = [];
  if (!presetModel) for (const file of [env.XDG_CACHE_HOME && path.join(env.XDG_CACHE_HOME, 'opencode/models.json'),
    ...homes.map(home => path.join(home, '.cache/opencode/models.json'))].filter(Boolean)) {
    const go = readJSON(file)?.['opencode-go'];
    if (go) { catalogs.push({file, go}); break; }
  }
  const cached = catalogs.flatMap(c => Object.keys(c.go.models || {})).filter(m => m.startsWith('deepseek'));
  const modelValue = presetModel || cached.find(m => m.includes('flash')) || cached[0];
  const model = modelValue?.replace(/^opencode-go\//, '');
  if (!model || !/^deepseek[\w.:-]*$/.test(model))
    throw new SafeError('需要 OpenCode Go 的 DeepSeek 模型；用 --model 或现有 OpenCode 配置选择', 'CONFIG');

  let apiKey, keySource;
  for (const name of ['AI_SNAKE_OPENCODE_GO_API_KEY', 'OPENCODE_GO_API_KEY']) {
    if (env[name]?.trim()) { apiKey = env[name].trim(); keySource = `env:${name}`; break; }
  }
  // OPENCODE_API_KEY may be a Zen key. Never use it as a Go credential.
  const authPaths = [env.AI_SNAKE_OPENCODE_AUTH_FILE, env.OPENCODE_AUTH_FILE,
    env.XDG_DATA_HOME && path.join(env.XDG_DATA_HOME, 'opencode/auth.json'),
    ...homes.map(home => path.join(home, '.local/share/opencode/auth.json'))].filter(Boolean);
  for (const file of authPaths) {
    if (apiKey) break;
    const entry = readJSON(file)?.['opencode-go'];
    if (entry?.type === 'api' && entry.key?.trim()) { apiKey = entry.key.trim(); keySource = `${file} [opencode-go]`; }
  }
  if (!apiKey) for (const c of goRecords) {
    apiKey = expand(c.data.provider['opencode-go'].options?.apiKey, env, c.directory);
    if (apiKey) { keySource = `${c.source} [provider.opencode-go.options.apiKey]`; break; }
  }
  if (!apiKey) throw new SafeError('没有 OpenCode Go 凭据；配置 OPENCODE_GO_API_KEY 或现有 auth.json 的 opencode-go 项', 'CONFIG');
  const configuredURL = goRecords.map(c => expand(c.data.provider['opencode-go'].options?.baseURL, env, c.directory)).find(Boolean);
  const catalog = catalogs.find(c => c.go.models?.[model]) || catalogs[0];
  const url = env.AI_SNAKE_OPENCODE_GO_URL || env.OPENCODE_GO_BASE_URL || configuredURL ||
    catalog?.go.models?.[model]?.provider?.api || catalog?.go.api || 'https://opencode.ai/inference/go/openai/v1';
  const result = {provider, model, baseUrl: baseURL(url).replace(/\/chat\/completions$/, ''), keySource,
    modelSource: options.model ? '--model' : env.AI_SNAKE_OPENCODE_MODEL ? 'env:AI_SNAKE_OPENCODE_MODEL' :
      env.OPENCODE_GO_MODEL ? 'env:OPENCODE_GO_MODEL' : active?.source || goRecords[0]?.source || catalog?.file};
  Object.defineProperty(result, 'apiKey', {value: apiKey, enumerable: false});
  return result;
}
