/** Standalone, dependency-free room service. Rules live exclusively in engine.js. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {newGame, createState, step, renderText, mapSize, finishGame, viewportFor, isFrozen, SKINS} from '../../web/public/ai-snake/engine.js';
import {normalizeSkin, decodeSkin, encodeSkin} from '../../web/public/ai-snake/skin.js';
import {resolveProvider, autoProviders, openaiModels} from './bots/providers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const copy = x => JSON.parse(JSON.stringify(x));
const secret = () => crypto.randomBytes(24).toString('base64url');
const digest = x => crypto.createHash('sha256').update(String(x || '')).digest('hex');
function fail(message, status = 400) { throw Object.assign(new Error(message), {status}); }
function integer(value, fallback, min, max) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`数值须为 ${min}–${max}`);
  return n;
}
export function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data), {mode: 0o600});
  fs.renameSync(temp, file);
}
// 自己捏的皮肤：skinData 是皮肤 JSON 对象，skinCode 是 SNK1. 码（链接、JSON 文本也认）。
// 存的一律是重新压好的 SNK1. 码；不对就把哪儿错了原样告诉对方，好让 AI 照着改。
function customSkin(p) {
  if (p.skinData === undefined && !String(p.skinCode || '').trim()) return '';
  try { return encodeSkin(p.skinData !== undefined ? normalizeSkin(p.skinData) : decodeSkin(String(p.skinCode).slice(0, 8000))); }
  catch (e) { fail(`皮肤没认出来：${e.message}`); }
}
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
// 每次调用最多给 32 步。按这局大概要走多少回合算够用的次数，多留 4 次给中途失败重想；
// 8 次垫底（旧的固定值），40 次封顶。不够用的 AI 会一路直走撞死。
// 纯 AI 局最快 40ms 一步，限时局按这个算，实际被模型想的时间卡住，用不满。
export function callBudget(config, tickMs = 350) {
  const turns = config.victory === 'score' ? Math.ceil((config.durationSeconds ?? 60) * 1000 / Math.max(1, tickMs)) : config.maxTurns;
  return Math.min(40, Math.max(8, Math.ceil((turns || 0) / 32) + 4));
}
function rules(r) {
  return {victory: r.game.config.victory || 'survival', world: r.game.config.world || 'arena',
    durationSeconds: r.game.config.durationSeconds ?? 60};
}
export class RoomService {
  constructor({dataDir = path.resolve(HERE, '../../data/ai-snake'), clock = Date.now,
    aiTimeoutMs = 60000, autoBots = true, notifyUrl, notifyToken, lobbyTtlMs, maxRooms} = {}) {
    const env = process.env;
    this.dataDir = dataDir; this.clock = clock; this.aiTimeoutMs = aiTimeoutMs;
    this.autoBots = autoBots; this.rooms = new Map(); this.children = new Set(); this.told = new Map();
    // 回调地址只认服务器主人配的环境变量，建房的人改不了。
    this.notifyUrl = notifyUrl ?? (env.AI_SNAKE_NOTIFY_URL?.trim() || null);
    if (this.notifyUrl && !/^https?:\/\/[^\s]+$/.test(this.notifyUrl)) throw new Error('AI_SNAKE_NOTIFY_URL 须为 http(s) 地址');
    this.notifyToken = notifyToken ?? (env.AI_SNAKE_NOTIFY_TOKEN || null);
    this.lobbyTtlMs = lobbyTtlMs ?? Math.max(1, Number(env.AI_SNAKE_LOBBY_TTL_MINUTES) || 30) * 60000;
    this.maxRooms = maxRooms ?? Math.min(64, Math.max(1, Number.parseInt(env.AI_SNAKE_MAX_ROOMS, 10) || 8));
    this.board = loadJSON(path.join(dataDir, 'leaderboard.json'), {players: {}, matches: {}, boards: {}});
    // Before explicit modes, every historical record belonged to survival/arena.
    if (!this.board.boards) this.board.boards = {'survival:arena': {victory: 'survival', world: 'arena',
      players: copy(this.board.players), matches: Object.fromEntries(Object.keys(this.board.matches).map(id => [id, true]))}};
    const roomDir = path.join(dataDir, 'rooms');
    if (fs.existsSync(roomDir)) for (const f of fs.readdirSync(roomDir).filter(f => /^[a-f0-9-]+\.json$/.test(f)).sort((a,b) => fs.statSync(path.join(roomDir,a)).mtimeMs - fs.statSync(path.join(roomDir,b)).mtimeMs)) {
      const r = loadJSON(path.join(roomDir, f));
      this.rooms.set(r.id, r);
      if (r.state.over) this.finish(r);
      else if (['running', 'warming'].includes(r.status)) {
        // Running clocks and deadlines survive a service restart, including downtime.
        if (!this.expire(r, clock())) { r.waitSince = clock(); r.nextTick = clock(); }
      }
    }
    this.trim();
  }
  trim() {
    const finished = [...this.rooms.values()].filter(r => r.status === 'finished');
    for (const r of finished.slice(0, -32)) this.rooms.delete(r.id);
  }
  // 只列这台服务器真能用的：OpenCode Go 找得到钥匙才列；openai 列 AI_SNAKE_OPENAI_MODEL 里的每一个。
  catalog() {
    const env = process.env, providers = autoProviders(env), models = [];
    if (providers.includes('opencode')) {
      try { resolveProvider({provider: 'opencode', env}); models.push({provider: 'opencode', model: 'deepseek-v4.1-flash', name: 'DS', skin: 'crab'}); }
      catch { /* 没配 OpenCode Go 钥匙就不列 */ }
    }
    if (providers.includes('ollama')) {
      const model = env.AI_SNAKE_OLLAMA_MODEL?.trim() || 'qwen3:8b';
      models.push({provider: 'ollama', model, name: model, skin: 'crab'});
    }
    if (providers.includes('openai')) for (const model of openaiModels(env))
      models.push({provider: 'openai', model, name: model, skin: 'crab'});
    models.push({provider: 'manual', model: 'manual', name: '手动 AI', skin: 'crab'});
    return {models};
  }
  get(id) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) fail('房间不存在', 404);
    let r = this.rooms.get(id);
    if (!r) {
      r = loadJSON(path.join(this.dataDir, 'rooms', `${id}.json`), null);
      if (!r) fail('房间不存在', 404);
      this.rooms.set(id, r); this.trim();
    }
    return r;
  }
  authorize(hash, token) { if (!token || digest(token) !== hash) fail('座位或房主凭证不对', 403); }
  save(r) { atomicJSON(path.join(this.dataDir, 'rooms', `${r.id}.json`), r); }
  waitMs(r) { return r.aiTimeoutMs ?? this.aiTimeoutMs; }
  frozenNext(r, id) { return isFrozen(r.state.snakes.find(s => s.id === id), r.state.turn + 1); }
  // 正在等谁交路线：活着、下一拍没被冻住、没挂机、排好的步子走空了的 AI。外部平台按这个去叫醒对应的住户。
  waitingFor(r) {
    if (!['warming', 'running'].includes(r.status) || r.state.over) return [];
    return r.players.filter(p => p.kind === 'ai' && r.state.snakes.find(s => s.id === p.id)?.alive &&
      !r.queues[p.id].length && !r.autoStraight?.[p.id] && !this.frozenNext(r, p.id)).map(p => p.id);
  }
  snapshot(r) {
    const modeRules = rules(r);
    const remainingMs = modeRules.victory !== 'score' ? null : r.status === 'finished' ? 0 :
      r.deadlineAt == null ? modeRules.durationSeconds * 1000 : Math.max(0, r.deadlineAt - this.clock());
    const waitingFor = this.waitingFor(r);
    return copy({id: r.id, status: r.status, mode: r.mode, config: r.game.config, state: r.state,
      ...modeRules, startedAt: r.startedAt ?? null, deadlineAt: r.deadlineAt ?? null, remainingMs,
      players: r.players.map(({tokenHash, ...p}) => p), tickMs: r.tickMs,
      plans: Object.fromEntries(r.players.map(p => [p.id, {remaining: r.queues[p.id].length}])),
      openSeats: r.status === 'lobby' ? r.players.filter(p => !p.joined && (p.kind === 'human' || p.provider === 'manual'))
        .map(p => ({id: p.id, kind: p.kind})) : [],
      waitingFor, waitDeadlineAt: r.mode === 'ai' && waitingFor.length ? r.waitSince + this.waitMs(r) : null,
      planWaitSeconds: this.waitMs(r) / 1000, missesBeforeAfk: r.missesBeforeAfk ?? 1,
      usage: r.usage, settlement: r.settlement, createdAt: r.createdAt});
  }
  // 发给服务器主人配的回调地址；发不出去就算了，不重试，不影响对局。
  notify(r, event, extra = {}) {
    if (!this.notifyUrl) return;
    try {
      fetch(this.notifyUrl, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: {'Content-Type': 'application/json', ...(this.notifyToken ? {Authorization: `Bearer ${this.notifyToken}`} : {})},
        body: JSON.stringify({event, roomId: r.id, status: r.status, turn: r.state.turn, at: this.clock(), ...extra})})
        .then(res => res.body?.cancel(), () => {});
    } catch { /* 回调失败不影响对局 */ }
  }
  create(body) {
    if ([...this.rooms.values()].filter(r => r.status !== 'finished').length >= this.maxRooms) fail(`同时最多 ${this.maxRooms} 个房间`, 409);
    const humans = body.humans || [], ais = body.ais || [];
    if (!Array.isArray(humans) || !Array.isArray(ais) || humans.length > 2 || ais.length < 1 || ais.length > 4) fail('需要 1–4 个 AI，最多 2 个人');
    const mode = body.mode || (humans.length ? 'mixed' : 'ai');
    if (!['ai', 'mixed'].includes(mode) || (mode === 'ai' && humans.length) || (mode === 'mixed' && !humans.length)) fail('玩法和人数不一致');
    const victory = body.victory === undefined ? 'survival' : body.victory;
    const world = body.world === undefined ? 'arena' : body.world;
    if (!['survival', 'score'].includes(victory)) fail('胜负规则须为 survival 或 score');
    if (!['arena', 'roam'].includes(world)) fail('世界须为 arena 或 roam');
    if (body.durationSeconds !== undefined && typeof body.durationSeconds !== 'number') fail('durationSeconds 须为整数秒数');
    const durationSeconds = integer(body.durationSeconds, 60, 1, 3600);
    const tickMs = integer(body.tickMs, 350, 100, 2000);
    // AI-only runs at most once per 40ms; its turn safety cap must outlast the clock.
    const requestedTurns = integer(body.maxTurns, 600, 1, victory === 'score' ? 90001 : 1200);
    const maxTurns = victory === 'score' ? Math.max(requestedTurns, durationSeconds * 25 + 1) : requestedTurns;
    // 外部住户想一步要几十秒：纯 AI 房间每轮最多等多久、连着超时几次才算挂机，建房时定。
    const planWaitMs = body.planWaitSeconds === undefined ? undefined : integer(body.planWaitSeconds, 60, 5, 600) * 1000;
    const missesBeforeAfk = integer(body.missesBeforeAfk, 1, 1, 5);
    const players = [...humans.map(p => ({...p, kind: 'human'})), ...ais.map(p => ({...p, kind: 'ai'}))].map((p, i) => {
      const provider = p.kind === 'human' ? null : (p.provider || 'manual');
      if (provider && provider !== 'manual' && !autoProviders().includes(provider)) fail('未知模型通道');
      const name = String(p.name || (p.kind === 'human' ? `玩家${i + 1}` : provider)).trim().slice(0, 40);
      if (!name) fail('名字不能为空');
      const model = String(p.model || (provider === 'opencode' ? 'deepseek-v4.1-flash' : provider === 'ollama' ? (process.env.AI_SNAKE_OLLAMA_MODEL?.trim() || 'qwen3:8b') :
        provider === 'openai' ? openaiModels()[0] : 'manual')).slice(0, 100);
      // openai 通道花的是服务器主人的钥匙：只认服务器列出来的模型，浏览器不能随便点名。
      if (provider === 'openai' && !openaiModels().includes(model)) fail('这个模型没有开放');
      // Auto providers are fixed adapters, never arbitrary browser-supplied URLs.
      const identity = p.kind === 'human' ? `human:${name}` : `ai:${provider}:${model}:${name}`;
      return {id: `p${i + 1}`, kind: p.kind, name: p.testBot ? `测试机器人 ${name}` : name, identity,
        skin: String(p.skin || 'crab').slice(0, 24), skinCode: customSkin(p),
        provider, model, joined: (p.kind === 'human' && i === 0) || (p.kind === 'ai' && provider !== 'manual'),
        testBot: Boolean(p.testBot), tokenHash: digest(secret())};
    });
    const id = crypto.randomUUID(), hostToken = secret(), first = players.find(p => p.kind === 'human');
    const token = first ? secret() : undefined;
    if (first) first.tokenHash = digest(token);
    const size = mapSize(players.length);
    const game = newGame({players, width: size, height: size, seed: body.seed,
      victory, world, durationSeconds, maxTurns, wrap: world === 'roam' ? false : body.wrap !== false,
      foodCount: Math.max(2, players.length), rewards: true, powerups: body.powerups !== false,
      guard: body.powerups !== false && body.guard !== false});
    const now = this.clock();
    const r = {id, hostHash: digest(hostToken), mode, players, game, state: createState(game.config),
      status: 'lobby', createdAt: new Date(now).toISOString(), activeAt: now, tickMs, startedAt: null, deadlineAt: null,
      ...(planWaitMs ? {aiTimeoutMs: planWaitMs} : {}), missesBeforeAfk,
      waitSince: now, nextTick: now, queues: {}, requests: {}, usage: {}, eaten: {}, autoStraight: {}, telemetry: [], settlement: null};
    for (const p of players) {
      r.queues[p.id] = []; r.requests[p.id] = [];
      r.usage[p.id] = {calls: 0, promptTokens: 0, completionTokens: 0, errors: 0}; r.eaten[p.id] = 0;
    }
    this.trim(); this.rooms.set(id, r); this.save(r);
    return {room: this.snapshot(r), hostToken, ...(first ? {playerId: first.id, token} : {})};
  }
  join(r, body) {
    if (r.status !== 'lobby') fail('对局已开始', 409);
    const p = r.players.find(p => !p.joined && p.kind === (body.kind || 'human') &&
      (!body.playerId || p.id === body.playerId) && (p.kind === 'human' || p.provider === 'manual'));
    if (!p) fail('没有空位', 409);
    // 皮肤先验：不对就整次入座不算，座位还空着，改好再来。
    const skinCode = body.skinData !== undefined || body.skinCode !== undefined ? customSkin(body) : undefined;
    if (body.skin && !Object.hasOwn(SKINS, body.skin)) fail(`没有「${String(body.skin).slice(0, 24)}」这个现成皮肤，可选：${Object.keys(SKINS).join(' / ')}`);
    const token = secret(); p.tokenHash = digest(token); p.joined = true;
    if (skinCode !== undefined) p.skinCode = skinCode;
    if (body.name) { p.name = String(body.name).slice(0, 40); p.identity = p.kind === 'human' ? `human:${p.name}` : `ai:manual:${p.model}:${p.name}`; }
    const cp = r.game.config.players.find(x => x.id === p.id), snake = r.state.snakes.find(x => x.id === p.id);
    cp.name = snake.name = p.name;
    if (body.skin) p.skin = cp.skin = snake.skin = body.skin;
    r.activeAt = this.clock();
    this.save(r); this.notify(r, 'joined', {playerId: p.id, name: p.name});
    return {room: this.snapshot(r), playerId: p.id, token};
  }
  // 开局前退座，座位空出来给别人；开局后不交路线就按超时处理。
  leave(r, body) {
    const p = r.players.find(p => p.id === body.playerId);
    if (!p) fail('座位不存在', 404);
    this.authorize(p.tokenHash, body.token);
    if (r.status !== 'lobby') fail('对局已开始，不能退座', 409);
    p.joined = false; p.tokenHash = digest(secret()); r.activeAt = this.clock();
    this.save(r); this.notify(r, 'left', {playerId: p.id});
    return {room: this.snapshot(r)};
  }
  cancel(r, body) {
    this.authorize(r.hostHash, body.hostToken);
    if (r.status !== 'lobby') fail('只能解散还没开局的房间', 409);
    this.drop(r, 'host');
    return {ok: true, roomId: r.id, status: r.status};
  }
  // 没开局的房间直接删掉，不进排行榜、不留回放。
  drop(r, reason) {
    r.status = 'cancelled'; this.rooms.delete(r.id); this.told.delete(r.id);
    fs.rmSync(path.join(this.dataDir, 'rooms', `${r.id}.json`), {force: true});
    this.notify(r, 'cancelled', {reason});
  }
  // 人没到齐就开局：撤掉空座，按剩下的人数重新摆地图，种子不变。
  reseat(r, kept) {
    if (!kept.length) fail('还没有人入座', 409);
    const c = r.game.config, size = mapSize(kept.length);
    r.players = kept;
    r.game = newGame({players: kept, width: size, height: size, seed: c.seed, victory: c.victory, world: c.world,
      durationSeconds: c.durationSeconds, maxTurns: c.maxTurns, wrap: c.wrap, foodCount: Math.max(2, kept.length),
      rewards: Boolean(c.rewards), powerups: Boolean(c.powerups), guard: Boolean(c.guard)});
    r.state = createState(r.game.config);
    for (const key of ['queues', 'requests', 'usage', 'eaten'])
      for (const id of Object.keys(r[key])) if (!kept.some(p => p.id === id)) delete r[key][id];
  }
  start(r, body) {
    this.authorize(r.hostHash, body.hostToken);
    if (r.status !== 'lobby') fail('对局已经开始', 409);
    if (!r.players.every(p => p.joined)) {
      if (body.dropEmpty !== true) fail('请等所有人和手动 AI 加入，或带 dropEmpty:true 撤掉空座开局', 409);
      this.reseat(r, r.players.filter(p => p.joined));
    }
    const autoCount = p => p.kind === 'ai' && p.provider !== 'manual';
    const busy = [...this.rooms.values()].filter(other => other.id !== r.id && ['warming', 'running'].includes(other.status))
      .reduce((n, other) => n + other.players.filter(autoCount).length, 0);
    if (busy + r.players.filter(autoCount).length > 4) fail('已有 AI 对局在运行，自动模型同时最多 4 个', 409);
    r.status = 'warming'; r.waitSince = this.clock(); r.nextTick = this.clock();
    this.save(r); this.launchBots(r);
    const waitingFor = this.waitingFor(r); this.told.set(r.id, waitingFor);
    this.notify(r, 'started', {waitingFor, deadlineAt: r.waitSince + this.waitMs(r)});
    return {room: this.snapshot(r)};
  }
  launchBots(r) {
    if (!this.autoBots || !this.baseURL) return;
    for (const p of r.players.filter(p => p.kind === 'ai' && p.provider !== 'manual')) {
      const key = `${r.id}:${p.id}`;
      if ([...this.children].some(c => c.seat === key)) continue;
      const token = secret(); p.tokenHash = digest(token);
      const child = spawn(process.execPath, ['--max-old-space-size=128', path.join(HERE, 'bots/run.mjs'), '--url', this.baseURL,
        '--room', r.id, '--player', p.id, '--provider', p.provider, '--model', p.model, '--max-calls', String(callBudget(r.game.config, r.mode === 'ai' ? 40 : r.tickMs))],
      {env: {...process.env, AI_SNAKE_PLAYER_TOKEN: token}, stdio: ['ignore', 'ignore', 'ignore']});
      child.seat = key; this.children.add(child);
      child.once('exit', () => this.children.delete(child));
      child.once('error', () => this.children.delete(child));
    }
    this.save(r);
  }
  plan(r, body) {
    const p = r.players.find(p => p.id === body.playerId);
    if (!p) fail('座位不存在', 404);
    this.authorize(p.tokenHash, body.token);
    this.expire(r);
    if (r.status === 'finished') return {room: this.snapshot(r), remaining: 0};
    const requestId = String(body.requestId || '').slice(0, 80);
    if (requestId && r.requests[p.id].includes(requestId)) return {room: this.snapshot(r), remaining: r.queues[p.id].length};
    let text = Array.isArray(body.moves) ? body.moves.join('') : String(body.moves || '');
    if (text && !/^[UDLR]+$/.test(text)) fail('只接受 UDLR 方向');
    // 吃到金身时旧路线已清空；照吃之前局面排的路线接不上现在的位置，收下用量、丢掉方向。
    const stale = Boolean(text) && Number.isInteger(body.basedOnTurn) && body.basedOnTurn < (r.replanFrom?.[p.id] ?? -1);
    if (stale) text = '';
    // 空路线只用来记用量或报错；外部住户什么都没给，直接告诉它交错了，别默默收下。
    if (!text && !stale && !body.usage && !body.error) fail('moves 不能为空：AI 每段至少 6 步');
    if (p.kind === 'ai' && text && text.length < 6) fail('AI 每段至少 6 步');
    if (text.length > 128 || r.queues[p.id].length + text.length > 128) fail('计划最多 128 步');
    // 跟当时朝向相反的步子引擎会忽略、照原方向直走。接着已排的步子推一遍，告诉它是第几步，免得它以为自己拐了弯。
    const reversed = [];
    if (p.kind === 'ai' && text) {
      const opposite = {U: 'D', D: 'U', L: 'R', R: 'L'};
      let dir = r.state.snakes.find(s => s.id === p.id)?.dir;
      for (const m of r.queues[p.id]) if (m !== opposite[dir]) dir = m;
      [...text].forEach((m, i) => { if (m === opposite[dir]) reversed.push(i + 1); else dir = m; });
    }
    if (p.kind === 'human' && text) {
      if (text.length !== 1) fail('真人每次提交一个方向');
      if (r.queues[p.id].length >= 4) fail('方向队列已满，请等下一拍', 409);
      r.queues[p.id].push(text);
    } else r.queues[p.id].push(...text);
    r.autoStraight ||= {};
    if (text) { delete r.autoStraight[p.id]; if (r.misses) delete r.misses[p.id]; }
    if (requestId) { r.requests[p.id].push(requestId); r.requests[p.id] = r.requests[p.id].slice(-64); }
    if (body.usage && p.kind === 'ai') for (const k of ['calls', 'promptTokens', 'completionTokens'])
      r.usage[p.id][k] += integer(body.usage[k], 0, 0, k === 'calls' ? 100 : 1000000);
    if (body.error) { r.autoStraight[p.id] = true; r.usage[p.id].errors++; r.telemetry.push({turn: r.state.turn, playerId: p.id, type: 'model_error', code: /^[A-Z_]{1,32}$/.test(body.errorCode || '') ? body.errorCode : 'UNKNOWN'}); }
    this.save(r); return {room: this.snapshot(r), remaining: r.queues[p.id].length, ...(stale ? {stale: true} : {}),
      ...(reversed.length ? {ignoredReverse: reversed, warning: `第 ${reversed.join('、')} 步跟当时的朝向相反，会被忽略、照原方向直走`} : {})};
  }
  look(r, id, token) {
    const p = r.players.find(p => p.id === id);
    if (!p) fail('座位不存在', 404);
    // 排好的步子只给本人看：带这个座位的凭证（X-Seat-Token）才返回 queuedMoves，别的玩家偷看不到你的路线。
    const own = typeof token === 'string' && token.length > 0 && digest(token) === p.tokenHash;
    return {room: this.snapshot(r), board: renderText(r.state, r.game.config, id),
      viewport: viewportFor(r.state, id), remaining: r.queues[id].length,
      ...(own ? {queuedMoves: r.queues[id].join('')} : {}), turn: r.state.turn, tickMs: r.tickMs,
      yourTurn: this.waitingFor(r).includes(id), howToPlay: this.howToPlay(r)};
  }
  // 给外部 AI 看的出手规矩，跟着这间房的设置写。
  howToPlay(r) {
    const seconds = Math.round(this.waitMs(r) / 1000), misses = r.missesBeforeAfk ?? 1;
    return [
      '出手（plan）：moves 用 U上 D下 L左 R右，一次给 6–128 步，排队总共最多 128 步。',
      '不能直接掉头：跟当时朝向（棋盘上的「朝 X」，排了步子就是排完以后的朝向）相反的那一步会被忽略、照原方向直走；交路线的回复里 ignoredReverse 会列出是第几步。',
      '你已经排好的步子（queuedMoves，带自己的座位凭证才看得到）先走完，新给的接在后面。',
      '每次出手带一个 requestId，重试时用同一个，不会重复排队；带 basedOnTurn（填这次看到的 turn）：你吃到金身时旧路线会被清掉，照更早局面排的会被丢掉，请重新排。',
      r.mode === 'ai' ? `这间房等所有活着的 AI 都排了步子才往下走，每轮最多等 ${seconds} 秒；` +
        (misses > 1 ? `超时一次替你直走一步、再等一轮，连着超时 ${misses} 次以后一直替你直走，直到你再交路线。` : '超时以后一直替你直走，直到你再交路线。') :
        `这间房有真人，按真实时间每 ${r.tickMs} 毫秒走一步，不等你；步子用完会一直直走。`,
      '挂着等（wait）：轮到你、你出局或对局结束才返回，最长 55 秒；没等到就再挂一次。',
    ].join('\n');
  }
  // 长轮询：轮到这个座位交路线、它出局、对局结束或被解散才返回；带 after 时局面走过那一回合也返回。
  async wait(r, id, token, {after, timeoutMs, closed = () => false} = {}) {
    if (!r.players.some(p => p.id === id)) fail('座位不存在', 404);
    const limit = timeoutMs == null || timeoutMs === '' ? 50000 : integer(timeoutMs, 50000, 0, 55000);
    const since = after == null || after === '' ? null : integer(after, 0, 0, 1e9);
    const why = () => {
      if (['cancelled', 'finished'].includes(r.status)) return r.status;
      if (r.status === 'lobby') return null;
      if (!r.state.snakes.find(s => s.id === id)?.alive) return 'dead';
      if (this.waitingFor(r).includes(id)) return 'your_turn';
      return since != null && r.state.turn > since ? 'turn' : null;
    };
    const end = Date.now() + limit;
    let reason = why();
    while (!reason && Date.now() < end && !closed()) {
      await new Promise(resolve => { const t = setTimeout(resolve, 100); t.unref?.(); });
      reason = why();
    }
    if (r.status === 'cancelled') return {reason: 'cancelled', roomId: r.id, status: r.status};
    return {reason: reason || 'timeout', ...this.look(r, id, token)};
  }
  expire(r, now = this.clock()) {
    if (r.status === 'finished' || rules(r).victory !== 'score' || r.deadlineAt == null || now < r.deadlineAt) return false;
    finishGame(r.state, r.game.config, 'time');
    r.game.ended = {turn: r.state.turn, reason: 'time'};
    this.finish(r);
    return true;
  }
  pump() {
    const now = this.clock();
    for (const r of [...this.rooms.values()]) {
      // 没人动的大厅房间过期删掉，免得占满房间上限。
      if (r.status === 'lobby' && now - (r.activeAt ?? Date.parse(r.createdAt)) > this.lobbyTtlMs) { this.drop(r, 'idle'); continue; }
      if (!['warming', 'running'].includes(r.status)) continue;
      // Check before readiness and nextTick: a slow or offline AI cannot pause time.
      if (this.expire(r, now)) continue;
      const ais = r.players.filter(p => p.kind === 'ai' && r.state.snakes.find(s => s.id === p.id)?.alive);
      r.autoStraight ||= {};
      const frozenNext = id => this.frozenNext(r, id);
      const ready = ais.every(p => r.queues[p.id].length > 0 || r.autoStraight[p.id] || frozenNext(p.id));
      const waitMs = this.waitMs(r), waiting = this.waitingFor(r), told = this.told.get(r.id) || [];
      const fresh = waiting.filter(id => !told.includes(id));
      this.told.set(r.id, waiting);
      if (fresh.length) this.notify(r, 'waiting', {waitingFor: waiting, fresh, deadlineAt: r.mode === 'ai' ? r.waitSince + waitMs : null});
      if (r.status === 'warming') {
        if (!ready && now - r.waitSince < waitMs) continue;
        r.telemetry.push({type: 'warmup', elapsedMs: now - r.waitSince, turn: r.state.turn});
        r.startedAt ??= now;
        if (rules(r).victory === 'score') r.deadlineAt ??= r.startedAt + rules(r).durationSeconds * 1000;
        r.status = 'running'; r.nextTick = now;
      }
      if (r.mode === 'ai' && !ready && now - r.waitSince < waitMs) continue;
      if (now < r.nextTick) continue;
      const moves = {};
      for (const s of r.state.snakes.filter(s => s.alive)) {
        // 被冻住的蛇这一拍不动，排好的路线留着解冻后接着走。
        if (frozenNext(s.id)) continue;
        const direction = r.queues[s.id].shift();
        moves[s.id] = direction || s.dir;
        if (!direction && r.players.find(p => p.id === s.id).kind === 'ai') {
          // 纯 AI 房间设了 missesBeforeAfk 时，超时先只替它直走这一步、下一轮接着等；连着超时这么多次才算挂机。
          const misses = (r.misses ||= {})[s.id] = (r.misses[s.id] || 0) + 1;
          if (r.mode !== 'ai' || misses >= (r.missesBeforeAfk ?? 1)) r.autoStraight[s.id] = true;
          r.telemetry.push({turn: r.state.turn, playerId: s.id, type: r.mode === 'ai' ? 'ai_timeout_straight' : 'plan_empty_straight'});
        }
      }
      r.game.moves.push(moves); step(r.state, r.game.config, moves);
      for (const e of r.state.events) if (e.type === 'eat') r.eaten[e.id]++;
      // 全 AI 房间会等 AI 交路线：吃到金身的 AI 清掉旧路线，整局停下等它带着金身重新排。
      // 有真人的房间按真实时间走，清了只会让它直走，路线照旧。想的次数用完了也不清，免得白等。
      if (r.mode === 'ai') for (const e of r.state.events) {
        if (e.type !== 'eat' || e.reward !== 'guard') continue;
        const p = r.players.find(p => p.id === e.id);
        if (p?.kind !== 'ai' || r.usage[p.id].calls >= callBudget(r.game.config, 40)) continue;
        r.queues[p.id] = []; delete r.autoStraight[p.id];
        (r.replanFrom ||= {})[p.id] = r.state.turn;
        r.telemetry.push({turn: r.state.turn, playerId: p.id, type: 'guard_replan'});
      }
      r.waitSince = now; r.nextTick = now + (r.mode === 'mixed' ? r.tickMs : 40);
      if (r.state.over) this.finish(r); else this.save(r);
    }
  }
  finish(r) {
    const fresh = r.status !== 'finished';
    r.finishedAt ??= r.status === 'finished' ? null : this.clock();
    r.status = 'finished';
    const modeRules = rules(r);
    if (!r.settlement) r.settlement = {roomId: r.id, winner: r.state.winner, turns: r.state.turn,
      mode: r.mode, ...modeRules, startedAt: r.startedAt ?? null, deadlineAt: r.deadlineAt ?? null,
      endReason: r.state.endReason || r.game.ended?.reason || 'over',
      players: r.players.map(p => {const s = r.state.snakes.find(s => s.id === p.id); return {
        id: p.id, name: p.name, identity: p.identity, kind: p.kind, testBot: p.testBot,
        score: s.score, length: s.body.length, alive: s.alive, deathReason: s.deathReason,
        eaten: r.eaten[p.id], won: r.state.winner === p.id, usage: r.usage[p.id]};})};
    const key = `${modeRules.victory}:${modeRules.world}`;
    const group = this.board.boards[key] ||= {...modeRules, players: {}, matches: {}};
    const add = records => {
      for (const p of r.settlement.players.filter(p => !p.testBot)) {
        const b = records[p.identity] ||= {identity: p.identity, name: p.name, kind: p.kind, best: 0, games: 0, wins: 0, totalEaten: 0};
        b.best = Math.max(b.best, p.score); b.games++; b.wins += Number(p.won); b.totalEaten += p.eaten;
      }
    };
    let boardChanged = false;
    if (!this.board.matches[r.id]) { add(this.board.players); boardChanged = true; }
    if (!group.matches[r.id]) { add(group.players); group.matches[r.id] = true; boardChanged = true; }
    if (typeof this.board.matches[r.id] !== 'object') {
      this.board.matches[r.id] = {roomId: r.id, mode: r.mode, ...modeRules, winner: r.state.winner,
        turns: r.state.turn, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt};
      boardChanged = true;
    }
    if (boardChanged) {
      atomicJSON(path.join(this.dataDir, 'leaderboard.json'), this.board);
    }
    this.save(r);
    atomicJSON(path.join(this.dataDir, 'replays', `${r.id}.json`), this.replay(r));
    for (const c of this.children) if (c.seat.startsWith(`${r.id}:`)) c.kill('SIGTERM');
    this.told.delete(r.id);
    if (fresh) this.notify(r, 'finished', {winner: r.settlement.winner, endReason: r.settlement.endReason,
      players: r.settlement.players.map(({id, name, score, length, alive, won}) => ({id, name, score, length, alive, won}))});
  }
  replay(r) {
    return copy({...r.game, players: r.players.map(({tokenHash, ...p}) => p), usage: r.usage,
      mode: r.mode, ...rules(r), startedAt: r.startedAt ?? null, deadlineAt: r.deadlineAt ?? null,
      timing: r.telemetry, settlement: r.settlement});
  }
  leaderboard() {
    const sorted = records => Object.values(records).sort((a,b) => b.best - a.best || b.wins - a.wins || b.totalEaten - a.totalEaten);
    const boards = {};
    for (const victory of ['survival', 'score']) for (const world of ['arena', 'roam']) {
      const key = `${victory}:${world}`;
      boards[key] = sorted(this.board.boards[key]?.players || {});
    }
    return {players: sorted(this.board.players), boards, matches: Object.entries(this.board.matches).map(([roomId, match]) =>
      typeof match === 'object' ? match : {roomId, mode: null, victory: 'survival', world: 'arena'})};
  }
  close() { for (const c of this.children) c.kill('SIGTERM'); }
}
export async function createServer(options = {}) {
  const service = new RoomService(options);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      // Standalone distribution hosts its own web assets on the same origin.
      // host application only proxies the API and serves its existing static build.
      const webRoot = path.resolve(HERE, '../../web/public/ai-snake');
      const asset = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
      if (req.method === 'GET' && /^(?:index|maker)\.html$|^[a-z][a-z-]*\.js$/.test(asset)) {
        const file = path.join(webRoot, asset);
        if (!fs.existsSync(file)) fail('文件不存在', 404);
        res.setHeader('Content-Type', asset.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
        res.end(fs.readFileSync(file)); return;
      }
      const route = url.pathname.replace(/^\/api\/ai-snake(?=\/|$)/, '').split('/').filter(Boolean);
      let body = {};
      if (req.method === 'POST') {
        let size = 0, chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 65536) fail('请求太大', 413); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { fail('JSON 格式不对'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('需要 JSON 对象');
      }
      let result;
      if (req.method === 'GET' && route.length === 1 && route[0] === 'health') result = {ok: true};
      else if (req.method === 'GET' && route[0] === 'catalog' && route.length === 1) result = service.catalog();
      else if (req.method === 'GET' && route[0] === 'leaderboard' && route.length === 1) result = service.leaderboard();
      else if (route[0] === 'rooms') {
        if (route.length === 1 && req.method === 'GET') {
          const status = url.searchParams.get('status');
          result = {rooms: [...service.rooms.values()].filter(r => !status || r.status === status).slice(-32).map(r => service.snapshot(r))};
        }
        else if (route.length === 1 && req.method === 'POST') { result = service.create(body); res.statusCode = 201; }
        else {
          const r = service.get(route[1]), action = route[2];
          if (route.length > 3) fail('接口不存在', 404);
          if (req.method === 'GET' && !action) result = service.snapshot(r);
          else if (req.method === 'GET' && action === 'look') result = service.look(r, url.searchParams.get('as'), req.headers['x-seat-token']);
          else if (req.method === 'GET' && action === 'wait') result = await service.wait(r, url.searchParams.get('as'), req.headers['x-seat-token'],
            {after: url.searchParams.get('after'), timeoutMs: url.searchParams.get('timeoutMs'), closed: () => req.socket.destroyed});
          else if (req.method === 'GET' && action === 'replay') result = service.replay(r);
          else if (req.method === 'GET' && action === 'settlement') result = {settlement: r.settlement};
          else if (req.method === 'POST' && ['join','start','plan','leave','cancel'].includes(action)) result = service[action](r, body);
          else fail('接口不存在', 404);
        }
      } else fail('接口不存在', 404);
      res.end(JSON.stringify(result));
    } catch (e) { res.statusCode = e.status || 500; res.end(JSON.stringify({error: e.status ? e.message : '房间服务错误'})); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, options.host || '127.0.0.1', resolve); });
  service.baseURL = `http://127.0.0.1:${server.address().port}`;
  for (const r of service.rooms.values()) if (['warming', 'running'].includes(r.status)) service.launchBots(r);
  const timer = setInterval(() => { try { service.pump(); } catch (e) { console.error('ai-snake tick failed:', e.code || e.name); } }, 25);
  timer.unref();
  server.on('close', () => { clearInterval(timer); service.close(); });
  return {server, service, url: service.baseURL};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const get = flag => {const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined;};
  const {server} = await createServer({port: Number(get('--port') || 8791), host: get('--host') || '127.0.0.1',
    dataDir: get('--data-dir') || process.env.AI_SNAKE_DATA_DIR});
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
