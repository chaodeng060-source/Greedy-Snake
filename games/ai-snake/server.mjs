/** Standalone, dependency-free room service. Rules live exclusively in engine.js. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {newGame, createState, step, renderText, mapSize, finishGame, viewportFor, isFrozen} from '../../web/public/ai-snake/engine.js';

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
    aiTimeoutMs = 60000, autoBots = true} = {}) {
    this.dataDir = dataDir; this.clock = clock; this.aiTimeoutMs = aiTimeoutMs;
    this.autoBots = autoBots; this.rooms = new Map(); this.children = new Set();
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
  catalog() {
    return {models: [
      {provider: 'opencode', model: 'deepseek-v4.1-flash', name: 'DS', skin: 'crab'},
      {provider: 'ollama', model: 'qwen3:8b', name: 'qwen3:8b', skin: 'crab'},
      {provider: 'manual', model: 'manual', name: '手动 AI', skin: 'crab'},
    ]};
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
  snapshot(r) {
    const modeRules = rules(r);
    const remainingMs = modeRules.victory !== 'score' ? null : r.status === 'finished' ? 0 :
      r.deadlineAt == null ? modeRules.durationSeconds * 1000 : Math.max(0, r.deadlineAt - this.clock());
    return copy({id: r.id, status: r.status, mode: r.mode, config: r.game.config, state: r.state,
      ...modeRules, startedAt: r.startedAt ?? null, deadlineAt: r.deadlineAt ?? null, remainingMs,
      players: r.players.map(({tokenHash, ...p}) => p), tickMs: r.tickMs,
      plans: Object.fromEntries(r.players.map(p => [p.id, {remaining: r.queues[p.id].length}])),
      usage: r.usage, settlement: r.settlement, createdAt: r.createdAt});
  }
  create(body) {
    if ([...this.rooms.values()].filter(r => r.status !== 'finished').length >= 8) fail('同时最多 8 个房间', 409);
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
    const players = [...humans.map(p => ({...p, kind: 'human'})), ...ais.map(p => ({...p, kind: 'ai'}))].map((p, i) => {
      const provider = p.kind === 'human' ? null : (p.provider || 'manual');
      if (provider && !['manual', 'opencode', 'ollama'].includes(provider)) fail('未知模型通道');
      const name = String(p.name || (p.kind === 'human' ? `玩家${i + 1}` : provider)).trim().slice(0, 40);
      if (!name) fail('名字不能为空');
      const model = String(p.model || (provider === 'opencode' ? 'deepseek-v4.1-flash' : provider === 'ollama' ? 'qwen3:8b' : 'manual')).slice(0, 100);
      // Auto providers are fixed adapters, never arbitrary browser-supplied URLs.
      const identity = p.kind === 'human' ? `human:${name}` : `ai:${provider}:${model}:${name}`;
      return {id: `p${i + 1}`, kind: p.kind, name: p.testBot ? `测试机器人 ${name}` : name, identity,
        skin: String(p.skin || 'crab').slice(0, 24), skinCode: String(p.skinCode || '').slice(0, 8000),
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
      status: 'lobby', createdAt: new Date(now).toISOString(), tickMs, startedAt: null, deadlineAt: null,
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
    const token = secret(); p.tokenHash = digest(token); p.joined = true;
    if (body.name) { p.name = String(body.name).slice(0, 40); p.identity = p.kind === 'human' ? `human:${p.name}` : `ai:manual:${p.model}:${p.name}`; }
    const cp = r.game.config.players.find(x => x.id === p.id); cp.name = p.name;
    r.state.snakes.find(x => x.id === p.id).name = p.name;
    this.save(r); return {room: this.snapshot(r), playerId: p.id, token};
  }
  start(r, body) {
    this.authorize(r.hostHash, body.hostToken);
    if (r.status !== 'lobby') fail('对局已经开始', 409);
    if (!r.players.every(p => p.joined)) fail('请等所有人和手动 AI 加入', 409);
    const autoCount = p => p.kind === 'ai' && p.provider !== 'manual';
    const busy = [...this.rooms.values()].filter(other => other.id !== r.id && ['warming', 'running'].includes(other.status))
      .reduce((n, other) => n + other.players.filter(autoCount).length, 0);
    if (busy + r.players.filter(autoCount).length > 4) fail('已有 AI 对局在运行，自动模型同时最多 4 个', 409);
    r.status = 'warming'; r.waitSince = this.clock(); r.nextTick = this.clock();
    this.save(r); this.launchBots(r); return {room: this.snapshot(r)};
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
    if (p.kind === 'ai' && text && text.length < 6) fail('AI 每段至少 6 步');
    if (text.length > 128 || r.queues[p.id].length + text.length > 128) fail('计划最多 128 步');
    if (p.kind === 'human' && text) {
      if (text.length !== 1) fail('真人每次提交一个方向');
      if (r.queues[p.id].length >= 4) fail('方向队列已满，请等下一拍', 409);
      r.queues[p.id].push(text);
    } else r.queues[p.id].push(...text);
    r.autoStraight ||= {};
    if (text) delete r.autoStraight[p.id];
    if (requestId) { r.requests[p.id].push(requestId); r.requests[p.id] = r.requests[p.id].slice(-64); }
    if (body.usage && p.kind === 'ai') for (const k of ['calls', 'promptTokens', 'completionTokens'])
      r.usage[p.id][k] += integer(body.usage[k], 0, 0, k === 'calls' ? 100 : 1000000);
    if (body.error) { r.autoStraight[p.id] = true; r.usage[p.id].errors++; r.telemetry.push({turn: r.state.turn, playerId: p.id, type: 'model_error', code: /^[A-Z_]{1,32}$/.test(body.errorCode || '') ? body.errorCode : 'UNKNOWN'}); }
    this.save(r); return {room: this.snapshot(r), remaining: r.queues[p.id].length, ...(stale ? {stale: true} : {})};
  }
  look(r, id) {
    if (!r.players.some(p => p.id === id)) fail('座位不存在', 404);
    return {room: this.snapshot(r), board: renderText(r.state, r.game.config, id),
      viewport: viewportFor(r.state, id),
      remaining: r.queues[id].length, queuedMoves: r.queues[id].join(''), turn: r.state.turn, tickMs: r.tickMs};
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
    for (const r of this.rooms.values()) {
      if (!['warming', 'running'].includes(r.status)) continue;
      // Check before readiness and nextTick: a slow or offline AI cannot pause time.
      if (this.expire(r, now)) continue;
      const ais = r.players.filter(p => p.kind === 'ai' && r.state.snakes.find(s => s.id === p.id)?.alive);
      r.autoStraight ||= {};
      const frozenNext = id => isFrozen(r.state.snakes.find(s => s.id === id), r.state.turn + 1);
      const ready = ais.every(p => r.queues[p.id].length > 0 || r.autoStraight[p.id] || frozenNext(p.id));
      if (r.status === 'warming') {
        if (!ready && now - r.waitSince < this.aiTimeoutMs) continue;
        r.telemetry.push({type: 'warmup', elapsedMs: now - r.waitSince, turn: r.state.turn});
        r.startedAt ??= now;
        if (rules(r).victory === 'score') r.deadlineAt ??= r.startedAt + rules(r).durationSeconds * 1000;
        r.status = 'running'; r.nextTick = now;
      }
      if (r.mode === 'ai' && !ready && now - r.waitSince < this.aiTimeoutMs) continue;
      if (now < r.nextTick) continue;
      const moves = {};
      for (const s of r.state.snakes.filter(s => s.alive)) {
        // 被冻住的蛇这一拍不动，排好的路线留着解冻后接着走。
        if (frozenNext(s.id)) continue;
        const direction = r.queues[s.id].shift();
        moves[s.id] = direction || s.dir;
        if (!direction && r.players.find(p => p.id === s.id).kind === 'ai') {
          r.autoStraight[s.id] = true;
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
        if (route.length === 1 && req.method === 'GET') result = {rooms: [...service.rooms.values()].slice(-32).map(r => service.snapshot(r))};
        else if (route.length === 1 && req.method === 'POST') { result = service.create(body); res.statusCode = 201; }
        else {
          const r = service.get(route[1]), action = route[2];
          if (route.length > 3) fail('接口不存在', 404);
          if (req.method === 'GET' && !action) result = service.snapshot(r);
          else if (req.method === 'GET' && action === 'look') result = service.look(r, url.searchParams.get('as'));
          else if (req.method === 'GET' && action === 'replay') result = service.replay(r);
          else if (req.method === 'GET' && action === 'settlement') result = {settlement: r.settlement};
          else if (req.method === 'POST' && ['join','start','plan'].includes(action)) result = service[action](r, body);
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
