#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {resolveProvider} from './providers.mjs';
import {ensureOllamaTunnel} from './ollama-tunnel.mjs';
import {baseURL, requestJSON, SafeError} from './http.mjs';
import {nearestTargets, describeTarget, REMAINS_VALUE, REWARDS, DOUBLE_TURNS, FREEZE_TURNS} from '../../../web/public/ai-snake/engine.js';
export {resolveProvider};
export {ensureOllamaTunnel};

const OPPOSITE = {U: 'D', D: 'U', L: 'R', R: 'L'};
const DELTA = {U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0]};
const count = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const usageOf = (data, provider) => ({calls: 0,
  promptTokens: count(provider === 'ollama' ? data.prompt_eval_count : data.usage?.prompt_tokens),
  completionTokens: count(provider === 'ollama' ? data.eval_count : data.usage?.completion_tokens)});

export function prefetchThreshold(latencyMs, tickMs) {
  return Math.max(18, Math.ceil(latencyMs / Math.max(1, tickMs || 350)) + 4);
}

// Project supplied directions only. This never chooses or submits an action.
export function queuedStart(look, player) {
  const snake = look.room?.state?.snakes?.find(s => s.id === player);
  if (!snake?.body?.[0]) return null;
  const config = look.room.config, head = [...snake.body[0]];
  let dir = snake.dir;
  const moves = Array.isArray(look.queuedMoves) ? look.queuedMoves.join('') : (look.queuedMoves || '');
  for (const move of moves) {
    if (DELTA[move] && move !== OPPOSITE[dir]) dir = move;
    if (!DELTA[dir]) return null;
    head[0] += DELTA[dir][0]; head[1] += DELTA[dir][1];
    if (config.wrap && config.world !== 'roam') {
      head[0] = (head[0] + config.width) % config.width;
      head[1] = (head[1] + config.height) % config.height;
    }
  }
  return {head, dir, afterQueuedMoves: moves, turn: look.turn + moves.length,
    assumption: 'Own queued moves only; assumes survival. Other snakes, food, and elapsed inference time can change the board.'};
}

export function buildPrompt(look, player, steps = 32) {
  const snake = look.room?.state?.snakes?.find(s => s.id === player);
  return [
    'Play multiplayer snake. Return ONLY valid JSON of the form {"moves":"URDL..."}. No prose, markdown, code or reasoning.',
    `Choose exactly ${steps} NEW moves using uppercase U D L R (at least 6 unless fewer turns remain). Do not reverse direction.`,
    'The board below shows the CURRENT positions, NOT the position where your new plan starts.',
    'Your queuedMoves will execute BEFORE the new moves. Continue AFTER them; do not repeat or replace the queued prefix.',
    'Use the projected own start below; the board shows bodies. Account for queued movement. Avoid collisions; seek candy/rewards when safe.',
    look.room.config.brawl ?
      `Other snakes move simultaneously. Hitting another body kills you. Heads entering the same cell kill ALL of them regardless of length, and nobody eats there. A dead snake's body turns into @ big candy worth ${REMAINS_VALUE} each; whoever reaches it first scores. U decreases y, R increases x.` :
      'Other snakes move simultaneously. Equal-length head collisions kill both; longer snakes win head collisions. U decreases y, R increases x.',
    'Plan toward the nearest valuable target listed below (* candy, + gold, $ bag, @ big candy): turn toward it instead of going straight forever.',
    ...(look.room.config.powerups ? [
      `Power-ups: & crown = ${REWARDS.big.value} points. % cherries = your points are doubled for the next ${DOUBLE_TURNS} turns. ~ snowflake = every OTHER snake freezes in place for ${FREEZE_TURNS} turns.`,
      'Frozen snakes do not move, eat or die; their whole body INCLUDING the head is a wall, and hitting it kills you. If YOU are frozen, your queued moves wait and resume after the freeze.',
    ] : []),
    look.room.config.world === 'roam' ?
      'Roam is an unbounded plane: never wrap, even if config.wrap is true. The board is a local viewport with a GLOBAL origin; every coordinate is GLOBAL. Leaving the viewport is not hitting a wall. Offscreen bodies can still collide.' :
      'Arena borders follow config.wrap: wrap if true, otherwise outer walls kill. Coordinates are global; viewport origin is (0,0).',
    look.room.config.victory === 'score' ?
      'Score victory: highest cumulative score among ALL entrants, even dead, wins at the real deadline. Death eliminates without respawn; one survivor continues. Equal top scores draw; length never breaks a tie. Inference waits consume remainingMs.' :
      'Survival victory: last living snake wins; simultaneous final deaths draw. At the turn safety cap, compare survival then score; equal top scores draw.',
    'Opposite turns are ignored. Empty queues continue straight on the server; never assume waiting pauses a mixed game.',
    'Inference takes time: the queue may partly execute while you think. Prefer a long survivable continuation.',
    JSON.stringify({playerId: player, turn: look.turn, tickMs: look.tickMs,
      config: {width: look.room.config.width, height: look.room.config.height, wrap: look.room.config.wrap, maxTurns: look.room.config.maxTurns,
        victory: look.room.config.victory, world: look.room.config.world, durationSeconds: look.room.config.durationSeconds},
      viewport: look.viewport, remainingMs: look.room.remainingMs,
      ownCurrent: snake && {id: snake.id, head: snake.body[0], dir: snake.dir, length: snake.body.length, score: snake.score,
        frozenTurnsLeft: Math.max(0, (snake.frozenUntil || 0) - look.turn), doubleTurnsLeft: Math.max(0, (snake.doubleUntil || 0) - look.turn)},
      queuedMoves: look.queuedMoves, remaining: look.remaining, projectedOwnStart: queuedStart(look, player)}),
    'CURRENT BOARD:', typeof look.board === 'string' ? look.board : JSON.stringify(look.board),
    ...projectedHint(look, player),
  ].join('\n');
}

// The board's hint is measured from the current head; with queued moves the plan starts elsewhere.
function projectedHint(look, player) {
  const start = queuedStart(look, player);
  if (!start || !start.afterQueuedMoves) return [];
  const near = nearestTargets(look.room.state, {...look.room.config, wrap: look.room.config.world !== 'roam' && look.room.config.wrap}, start.head, 3);
  return near.length ? [`FROM YOUR PROJECTED START (${start.head.join(',')}), AFTER QUEUED MOVES, NEAREST: ` + near.map(describeTarget).join('; ')] : [];
}

export async function requestPlan(provider, look, {player, steps = 32, fetchImpl, signal, timeoutMs = 55000, sessionId} = {}) {
  const messages = [{role: 'user', content: buildPrompt(look, player, steps)}];
  const ollama = provider.provider === 'ollama';
  const body = ollama ? {model: provider.model, messages, stream: false, think: false,
    format: {type: 'object', properties: {moves: {type: 'string', pattern: '^[UDLR]+$'}}, required: ['moves'], additionalProperties: false},
    options: {temperature: 0, num_ctx: 4096, num_predict: 128}} : {
    model: provider.model, messages, stream: false, temperature: 0, max_tokens: 512,
    reasoning_effort: 'none', response_format: {type: 'json_object'},
  };
  const requestOptions = {
    body, fetchImpl, signal, timeoutMs: Math.min(55000, Math.max(1, timeoutMs)), label: provider.provider,
    headers: ollama ? {} : {Authorization: `Bearer ${provider.apiKey}`,
      'User-Agent': 'ai-snake-room/1.0', 'x-opencode-session': sessionId || `ai-snake/${look.room.id}/${player}`},
  };
  const data = ollama && provider.requestJSON ? await provider.requestJSON(body, requestOptions) :
    await requestJSON(`${provider.baseUrl}${ollama ? '/api/chat' : '/chat/completions'}`, requestOptions);
  const usage = usageOf(data, provider.provider);
  const content = ollama ? data.message?.content : data.choices?.[0]?.message?.content;
  let result;
  try { result = JSON.parse(content); } catch { throw new SafeError('模型未返回有效的 moves JSON', 'MODEL_JSON', usage); }
  const minimum = Math.min(6, steps);
  // 模型常多给几步、夹空格或小写；只取它自己给的前 steps 步，不替它补步。
  const moves = typeof result?.moves === 'string' ? result.moves.toUpperCase().replace(/[\s,]/g, '') : '';
  if (!/^[UDLR]+$/.test(moves) || moves.length < minimum)
    throw new SafeError('模型 moves 长度或方向无效', 'MODEL_MOVES', usage);
  return {moves: moves.slice(0, steps), usage};
}

/** Returns when finished/dead, budget exhausted, or the model fails 3 times in a row. No algorithm fallback. */
export const MAX_CONSECUTIVE_FAILURES = 3;
export async function runBot(options = {}) {
  const {env = process.env, fetchImpl, sleep = delay, now = Date.now, signal} = options;
  const {room, player} = options;
  const token = options.token || env.AI_SNAKE_PLAYER_TOKEN;
  if (!room || !player || !token) throw new SafeError('需要 room、player 和 AI_SNAKE_PLAYER_TOKEN', 'CONFIG');
  const url = `${baseURL(options.url)}/rooms/${encodeURIComponent(room)}`;
  const maxCalls = Number(options.maxCalls ?? 8);
  if (!Number.isInteger(maxCalls) || maxCalls < 0) throw new SafeError('max-calls 须为非负整数', 'CONFIG');
  const totals = {calls: 0, promptTokens: 0, completionTokens: 0};
  let provider, connection, lastLatencyMs = 0, failures = 0;
  const runId = randomUUID();
  const post = (body, requestId) => requestJSON(`${url}/plan`, {fetchImpl, signal,
    body: {playerId: player, token, moves: '', ...body, requestId}});
  const done = reason => ({reason, ...totals, provider: provider?.provider, model: provider?.model});
  try {
    while (!signal?.aborted) {
      const look = await requestJSON(`${url}/look?as=${encodeURIComponent(player)}`, {fetchImpl, signal});
      // The budget belongs to the game, including calls admitted before a restart.
      const persisted = look.room.usage?.[player];
      for (const key of Object.keys(totals)) totals[key] = Math.max(totals[key], count(persisted?.[key]));
      const me = look.room.state?.snakes?.find(s => s.id === player);
      if (look.room.status === 'finished' || look.room.state?.over || me?.alive === false ||
        (look.room.config.victory === 'score' && look.room.remainingMs === 0)) return done('game-end');
      if (totals.calls >= maxCalls) return done('max-calls');
      const remaining = look.remaining ?? look.room.plans?.[player]?.remaining ?? 0;
      const turnsLeft = Math.max(0, (look.room.config.maxTurns ?? 600) - look.turn - remaining);
      if (!turnsLeft) return done('planned-to-end');
      // API v1 currently enforces >=6 for all AI plans, including the last one.
      const steps = Math.min(32, 128 - remaining, Math.max(6, turnsLeft));
      if (['warming', 'running'].includes(look.room.status) && remaining <= prefetchThreshold(lastLatencyMs, look.tickMs) && steps >= 6) {
        if (!provider) {
          try {
            provider = resolveProvider({...options, env});
            if (provider.provider === 'ollama') {
              connection = await (options.ensureOllama || ensureOllamaTunnel)(provider, {env, fetchImpl, signal});
              provider = connection.provider;
            }
          }
          catch (error) {
            await post({error: error instanceof SafeError ? error.message : 'provider 配置失败',
              errorCode: error instanceof SafeError ? error.code : 'CONFIG', usage: {calls: 0, promptTokens: 0, completionTokens: 0}}, `${runId}:config`);
            return done('config-error');
          }
        }
        const callId = `${runId}:${totals.calls + 1}`;
        // Persist admission BEFORE the paid request: finishing rooms may kill us mid-fetch.
        const admitted = await post({usage: {calls: 1, promptTokens: 0, completionTokens: 0}}, `${callId}:call`);
        if (admitted.room?.status === 'finished') return done('game-end');
        totals.calls++;
        const started = now();
        let result;
        try {
          result = await requestPlan(provider, look, {player, steps, fetchImpl, signal,
            timeoutMs: options.timeoutMs, sessionId: `ai-snake/${room}/${player}`});
        } catch (error) {
          const usage = error.usage || {calls: 0, promptTokens: 0, completionTokens: 0};
          totals.promptTokens += usage.promptTokens; totals.completionTokens += usage.completionTokens;
          await post({error: error instanceof SafeError ? error.message : '模型调用失败',
            errorCode: error instanceof SafeError ? error.code : 'MODEL', usage}, `${callId}:result`);
          // 一次答坏不该让这条蛇后半局一路直走：服务端先替它直走，下一圈再问；连错 3 次才放弃。
          if (++failures >= MAX_CONSECUTIVE_FAILURES) return done('model-error');
          if (totals.calls >= maxCalls) return done('max-calls');
          continue;
        }
        failures = 0;
        lastLatencyMs = now() - started;
        totals.promptTokens += result.usage.promptTokens; totals.completionTokens += result.usage.completionTokens;
        await post(result, `${callId}:result`);
        if (totals.calls >= maxCalls) return done('max-calls');
      }
      await sleep(100, undefined, signal ? {signal} : undefined);
    }
    return done('cancelled');
  } finally { await connection?.close(); }
}

async function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new SafeError('runner 参数须使用 --flag value', 'CONFIG');
    a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  if (a['check-provider']) {
    const p = resolveProvider({provider: a.provider, model: a.model});
    console.log(JSON.stringify(p)); return;
  }
  const controller = new AbortController(), abort = () => controller.abort();
  process.once('SIGTERM', abort); process.once('SIGINT', abort);
  try {
    const result = await runBot({url: a.url, room: a.room, player: a.player,
      provider: a.provider, model: a.model, maxCalls: a['max-calls'], signal: controller.signal});
    console.log(JSON.stringify(result));
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof SafeError ? error.message : 'bot 运行失败');
    process.exitCode = 1;
  });
}
