// AI 贪吃蛇的规则引擎：网页、命令行、MCP 共用这一份。
// 一局 = config + 每回合的出手记录；同样的 config 和出手，任何地方重放出来都一样。

export const FORMAT = "ai-snake/1";
export const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
const OPPOSITE = { U: "D", D: "U", L: "R", R: "L" };
const DIR_ALIASES = {
  U: "U", D: "D", L: "L", R: "R",
  "上": "U", "下": "D", "左": "L", "右": "R",
  "↑": "U", "↓": "D", "←": "L", "→": "R",
  W: "U", S: "D", A: "L",
};

import { PRIVATE_SKINS } from "./private-skins.js";
export const SKINS = { crab: { name: "小螃蟹", letter: "K" } };

// mulberry32：给糖的位置用，种子一样，糖落的地方就一样。
function nextRandom(seed) {
  let t = (seed + 0x6d2b79f5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), t | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, t];
}

export function parseMoves(text) {
  const out = [];
  for (const ch of String(text || "").toUpperCase()) {
    const d = DIR_ALIASES[ch];
    if (d) out.push(d);
  }
  return out;
}

function startLayout(width, height, count) {
  const midY = Math.floor(height / 2);
  const left = 2, right = width - 3;
  if (count === 1) return [{ head: [Math.floor(width / 2) - 2, midY], dir: "R" }];
  const spots = [
    { head: [left + 2, Math.floor(height / 3)], dir: "R" },
    { head: [right - 2, height - 1 - Math.floor(height / 3)], dir: "L" },
    { head: [right - 2, Math.floor(height / 3)], dir: "L" },
    { head: [left + 2, height - 1 - Math.floor(height / 3)], dir: "R" },
  ];
  if (count > 4) {
    const rows = [Math.floor(height / 5), Math.floor(height / 2), height - 1 - Math.floor(height / 5)];
    return rows.flatMap(y => [{ head: [4, y], dir: "R" }, { head: [width - 5, y], dir: "L" }]).slice(0, count);
  }
  return spots.slice(0, count);
}

export function mapSize(count) {
  if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error("人数须为 1–6");
  return 15 + 4 * (count - 1);
}

// wrap=true 是穿墙：从一边出去，从对面进来，只有咬到身子才出局。
// brawl：照贪吃蛇大作战的规矩——撞头不分长短一起出局，死了身子变大糖。
// 旧局的 config 没有这个字段，照旧规则重放，回放不会变。
export const REMAINS_VALUE = 2;

// powerups：奖励里多三样——双倍樱桃（之后 10 回合得分翻倍）、冻结雪花（其他蛇原地定住 3 回合）、
// 大奖皇冠（10 分）。旧局的 config 没有这个字段，只刷金南瓜和糖果袋，回放不会变。
export const DOUBLE_TURNS = 10;
export const FREEZE_TURNS = 3;
export const REWARDS = {
  gold: { mark: "+", value: 3, name: "金南瓜" },
  bag: { mark: "$", value: 5, name: "糖果袋" },
  double: { mark: "%", value: 0, name: "双倍樱桃", note: `吃到后 ${DOUBLE_TURNS} 回合得分翻倍` },
  freeze: { mark: "~", value: 0, name: "冻结雪花", note: `吃到后其他蛇原地定住 ${FREEZE_TURNS} 回合` },
  big: { mark: "&", value: 10, name: "大奖皇冠" },
};
const rewardMark = (kind) => REWARDS[kind]?.mark || "$";

// 被冻住的蛇这一回合不动、不吃、不会死，整条身子连头都当墙。
export function isFrozen(snake, turn) {
  return (snake.frozenUntil || 0) >= turn;
}

export function newConfig({ width = 15, height = 15, seed, foodCount, maxTurns = 600, players, wrap = false, rewards = false, rewardEvery = 10, rewardLife = 18, victory, world, durationSeconds, brawl = true, powerups = false } = {}) {
  const ps = (players && players.length ? players : [{ id: "crab", skin: "crab" }]).map((p, i) => {
    const skin = SKINS[p.skin] ? p.skin : Object.keys(SKINS)[i % Object.keys(SKINS).length];
    return { id: String(p.id || skin), name: p.name || SKINS[skin].name, skin };
  });
  if (ps.length > 6) throw new Error("最多 6 条蛇");
  if (new Set(ps.map(p => p.id)).size !== ps.length) throw new Error("玩家 id 必须不同");
  if (![width, height].every(n => Number.isInteger(n) && n >= 6 && n <= 80)) throw new Error("地图边长须为 6–80");
  if (victory != null && !["survival", "score"].includes(victory)) throw new Error("未知胜负玩法");
  if (world != null && !["arena", "roam"].includes(world)) throw new Error("未知地图玩法");
  if (durationSeconds != null && (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600)) throw new Error("时长须为 1–3600 秒");
  return {
    width, height,
    seed: seed == null ? Math.floor(Math.random() * 2 ** 31) : seed >>> 0,
    foodCount: foodCount || (ps.length > 1 ? 2 : 1),
    maxTurns,
    wrap: Boolean(wrap),
    players: ps,
    ...(victory ? {victory} : {}),
    ...(world ? {world} : {}),
    ...(victory === "score" ? {durationSeconds: durationSeconds ?? 60} : {}),
    ...(rewards ? { rewards: true, rewardEvery: Math.max(1, rewardEvery | 0), rewardLife: Math.max(1, rewardLife | 0) } : {}),
    ...(rewards && powerups ? { powerups: true } : {}),
    ...(brawl ? { brawl: true } : {}),
  };
}

export function createState(config) {
  const { width, height } = config;
  const layout = startLayout(width, height, config.players.length);
  const snakes = config.players.map((p, i) => {
    const { head, dir } = layout[i];
    const [dx, dy] = DIRS[dir];
    const body = [0, 1, 2].map((k) => [head[0] - dx * k, head[1] - dy * k]);
    return { id: p.id, name: p.name, skin: p.skin, body, dir, alive: true, score: 0, deathTurn: null, deathReason: null };
  });
  const state = { width, height, turn: 0, rng: config.seed, snakes, food: [], over: false, winner: null, events: [] };
  if (config.rewards) state.rewards = [];
  if (config.brawl) state.remains = [];
  if (config.world === "roam") {
    state.world = {chunkSize: 16, chunks: [], consumed: {}};
    refreshWorld(state, config);
  } else fillFood(state, config.foodCount);
  return state;
}

function occupied(state) {
  const set = new Set();
  for (const s of state.snakes) if (s.alive) for (const [x, y] of s.body) set.add(x + "," + y);
  return set;
}

function fillFood(state, count) {
  const taken = occupied(state);
  for (const [x, y] of state.food) taken.add(x + "," + y);
  for (const r of state.rewards || []) taken.add(r.x + "," + r.y);
  for (const [x, y] of state.remains || []) taken.add(x + "," + y);
  const free = [];
  for (let y = 0; y < state.height; y++)
    for (let x = 0; x < state.width; x++) if (!taken.has(x + "," + y)) free.push([x, y]);
  while (state.food.length < count && free.length) {
    const [r, next] = nextRandom(state.rng);
    state.rng = next;
    const [cell] = free.splice(Math.floor(r * free.length), 1);
    state.food.push(cell);
  }
}

// Only head neighborhoods are materialized. Bodies stay global and sparse.
export function viewportFor(state, asId) {
  if (!state.world) return {x: 0, y: 0, width: state.width, height: state.height};
  const target = state.snakes.find(s => s.id === asId) || state.snakes.find(s => s.alive) || state.snakes[0];
  const head = target?.body[0] || [0, 0];
  return {x: head[0] - Math.floor(state.width / 2), y: head[1] - Math.floor(state.height / 2), width: state.width, height: state.height};
}
function chunkSeed(seed, x, y) {
  let hash = (seed ^ 2166136261) >>> 0;
  for (const char of `${x},${y}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}
function chunkFood(config, x, y, size) {
  let rng = chunkSeed(config.seed, x, y);
  const positions = [];
  while (positions.length < 2) {
    let r; [r, rng] = nextRandom(rng); const dx = Math.floor(r * size);
    [r, rng] = nextRandom(rng); const dy = Math.floor(r * size);
    const cell = [x * size + dx, y * size + dy];
    if (!positions.some(p => p[0] === cell[0] && p[1] === cell[1])) positions.push(cell);
  }
  return positions;
}
function refreshWorld(state, config) {
  const world = state.world, size = world.chunkSize;
  const radius = Math.ceil(Math.max(state.width, state.height) / 2 / size);
  const chunks = new Map();
  for (const snake of state.snakes.filter(s => s.alive)) {
    const [hx, hy] = snake.body[0], cx = Math.floor(hx / size), cy = Math.floor(hy / size);
    for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++)
      chunks.set(`${x},${y}`, {x, y});
  }
  world.chunks = [...chunks.values()].sort((a,b) => a.y - b.y || a.x - b.x);
  const bodies = occupied(state);
  state.food = [];
  for (const chunk of world.chunks) for (const cell of chunkFood(config, chunk.x, chunk.y, size)) {
    const key = cell.join(',');
    if (bodies.has(key)) world.consumed[key] = true;
    if (!world.consumed[key]) state.food.push(cell);
  }
  if (state.rewards) state.rewards = state.rewards.filter(r => chunks.has(`${Math.floor(r.x / size)},${Math.floor(r.y / size)}`));
}

// Expiration and placement depend on turns + the shared RNG, never wall-clock time.
function refreshRewards(state, config) {
  if (!config.rewards) return;
  state.rewards = state.rewards.filter(r => r.expiresAt > state.turn);
  if (state.turn % config.rewardEvery || state.rewards.length >= 2) return;
  const taken = occupied(state);
  for (const [x, y] of state.food) taken.add(`${x},${y}`);
  for (const r of state.rewards) taken.add(`${r.x},${r.y}`);
  for (const [x, y] of state.remains || []) taken.add(`${x},${y}`);
  const free = [];
  const regions = state.world ? state.world.chunks.map(c => ({x: c.x * state.world.chunkSize, y: c.y * state.world.chunkSize, width: state.world.chunkSize, height: state.world.chunkSize})) : [{x: 0, y: 0, width: state.width, height: state.height}];
  for (const region of regions) for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++)
    if (!taken.has(`${x},${y}`)) free.push([x, y]);
  if (!free.length) return;
  const [r, next] = nextRandom(state.rng); state.rng = next;
  const [type, next2] = nextRandom(state.rng); state.rng = next2;
  const [x, y] = free[Math.floor(r * free.length)];
  // 冻结最稀有、皇冠其次；没开 powerups 的旧局还是三成糖果袋、七成金南瓜。
  const kind = config.powerups
    ? (type < 0.25 ? "bag" : type < 0.37 ? "double" : type < 0.45 ? "freeze" : type < 0.52 ? "big" : "gold")
    : (type < 0.3 ? "bag" : "gold");
  const half = Math.max(2, Math.floor(config.rewardLife / 2));
  const life = { gold: config.rewardLife, bag: half, double: Math.max(2, Math.floor(config.rewardLife * 2 / 3)), freeze: half, big: Math.max(2, Math.floor(config.rewardLife / 3)) }[kind];
  state.rewards.push({x, y, kind, value: REWARDS[kind].value, expiresAt: state.turn + life});
}

// 死掉的蛇每一节变一颗大糖；跟活蛇身子、糖、奖励重叠的格子和出了边框的格子不放。
function dropRemains(state, ids) {
  const taken = occupied(state);
  for (const [x, y] of state.food) taken.add(`${x},${y}`);
  for (const r of state.rewards || []) taken.add(`${r.x},${r.y}`);
  for (const [x, y] of state.remains) taken.add(`${x},${y}`);
  for (const id of ids) {
    const s = state.snakes.find((q) => q.id === id);
    let count = 0;
    for (const [x, y] of s.body) {
      const k = `${x},${y}`;
      if (taken.has(k)) continue;
      if (!state.world && (x < 0 || y < 0 || x >= state.width || y >= state.height)) continue;
      taken.add(k);
      state.remains.push([x, y]);
      count++;
    }
    if (count) state.events.push({ type: "remains", id, count });
  }
}

// 离 from 最近的几颗糖/奖励/大糖。穿墙的局按穿过去的近路算。给 AI 指路用，不替它出手。
export function nearestTargets(state, config, from, limit = 3) {
  const wrap = config.wrap && !state.world;
  const delta = (a, b, size) => {
    let d = b - a;
    if (wrap) { d = ((d % size) + size) % size; if (d > size / 2) d -= size; }
    return d;
  };
  const items = [
    ...state.food.map(([x, y]) => ({ x, y, mark: "*", value: 1 })),
    ...(state.rewards || []).map((r) => ({ x: r.x, y: r.y, mark: rewardMark(r.kind), value: r.value, note: REWARDS[r.kind]?.note })),
    ...(state.remains || []).map(([x, y]) => ({ x, y, mark: "@", value: REMAINS_VALUE })),
  ];
  return items
    .map((it) => {
      const dx = delta(from[0], it.x, state.width), dy = delta(from[1], it.y, state.height);
      return { ...it, dx, dy, steps: Math.abs(dx) + Math.abs(dy) };
    })
    .filter((it) => it.steps > 0)
    .sort((a, b) => a.steps - b.steps || b.value - a.value || a.y - b.y || a.x - b.x)
    .slice(0, limit);
}

export function describeTarget(t) {
  const parts = [];
  if (t.dx) parts.push(`${t.dx > 0 ? "右" : "左"} ${Math.abs(t.dx)}（${t.dx > 0 ? "R" : "L"}×${Math.abs(t.dx)}）`);
  if (t.dy) parts.push(`${t.dy > 0 ? "下" : "上"} ${Math.abs(t.dy)}（${t.dy > 0 ? "D" : "U"}×${Math.abs(t.dy)}）`);
  return `${t.mark}(${t.x},${t.y}) ${t.note || `值 ${t.value} 分`}，在你${parts.join("、")}，共 ${t.steps} 步`;
}

// 走一回合。moves: { 蛇id: "U"|"D"|"L"|"R" }，没给的蛇沿原方向走；往回掉头不算数，照原方向走。
export function step(state, config, moves = {}) {
  if (state.over) return state;
  state.turn += 1;
  state.events = [];
  if (config.rewards) state.rewards = state.rewards.filter(r => r.expiresAt > state.turn);
  const alive = state.snakes.filter((s) => s.alive);
  // 被冻住的蛇这一拍原地不动；没开 powerups 的局里谁都不会被冻住，movers 就是 alive。
  const frozen = new Set(config.powerups ? alive.filter((s) => isFrozen(s, state.turn)).map((s) => s.id) : []);
  const movers = alive.filter((s) => !frozen.has(s.id));

  for (const s of movers) {
    const want = moves[s.id];
    if (want && DIRS[want] && want !== OPPOSITE[s.dir]) s.dir = want;
  }

  const heads = new Map();
  for (const s of movers) {
    const [dx, dy] = DIRS[s.dir];
    let hx = s.body[0][0] + dx, hy = s.body[0][1] + dy;
    if (config.wrap && !state.world) {
      hx = (hx + state.width) % state.width;
      hy = (hy + state.height) % state.height;
    }
    heads.set(s.id, [hx, hy]);
  }

  // brawl：几个头同一拍挤进同一格，算撞头，这一格的糖谁也吃不到。
  const clash = new Set();
  if (config.brawl) {
    const byCell = new Map();
    for (const s of movers) {
      const k = heads.get(s.id).join(",");
      byCell.set(k, [...(byCell.get(k) || []), s.id]);
    }
    for (const ids of byCell.values()) if (ids.length > 1) ids.forEach((id) => clash.add(id));
  }

  const eaten = new Set();
  const rewardEaten = new Set();
  const remainsEaten = new Set();
  const freezers = [];
  for (const s of movers) {
    const h = heads.get(s.id);
    s.body.unshift(h);
    if (clash.has(s.id)) {
      if (s.growth > 0) s.growth--;
      else s.body.pop();
      continue;
    }
    // 双倍只翻得分，不翻长度。
    const mult = config.powerups && (s.doubleUntil || 0) >= state.turn ? 2 : 1;
    const fi = state.food.findIndex(([x, y]) => x === h[0] && y === h[1]);
    const ri = (state.rewards || []).findIndex(r => r.x === h[0] && r.y === h[1]);
    const mi = (state.remains || []).findIndex(([x, y]) => x === h[0] && y === h[1]);
    if (mi >= 0) {
      remainsEaten.add(mi);
      s.score += REMAINS_VALUE * mult;
      s.growth = (s.growth || 0) + REMAINS_VALUE - 1;
      state.events.push({ type: "eat", id: s.id, at: h, reward: "remains", value: REMAINS_VALUE * mult });
      if (fi >= 0) { eaten.add(fi); if (state.world) state.world.consumed[h.join(',')] = true; }
    } else if (ri >= 0) {
      const reward = state.rewards[ri]; rewardEaten.add(ri);
      s.score += reward.value * mult;
      // 皇冠 10 分也最多长 4 节（跟糖果袋一样），不然一口长成一堵墙。
      s.growth = (s.growth || 0) + Math.max(0, Math.min(reward.value, 5) - 1);
      if (reward.kind === "double") s.doubleUntil = state.turn + DOUBLE_TURNS;
      if (reward.kind === "freeze") freezers.push(s.id);
      state.events.push({type: "eat", id: s.id, at: h, reward: reward.kind, value: reward.value * mult});
    } else if (fi >= 0) {
      eaten.add(fi);
      if (state.world) state.world.consumed[h.join(',')] = true;
      s.score += mult;
      state.events.push(mult > 1 ? { type: "eat", id: s.id, at: h, value: mult } : { type: "eat", id: s.id, at: h });
    } else if (s.growth > 0) {
      s.growth--;
    } else {
      s.body.pop();
    }
  }
  state.food = state.food.filter((_, i) => !eaten.has(i));
  if (config.rewards) state.rewards = state.rewards.filter((_, i) => !rewardEaten.has(i));
  if (state.remains) state.remains = state.remains.filter((_, i) => !remainsEaten.has(i));

  const dead = new Map();
  const bodyCount = new Map();
  for (const s of alive)
    s.body.forEach(([x, y], i) => {
      const k = x + "," + y;
      // 冻住的蛇连头也是墙，撞上去的那条出局。
      bodyCount.set(k, (bodyCount.get(k) || 0) + (i === 0 && !frozen.has(s.id) ? 0 : 1));
    });
  for (const s of movers) {
    const [x, y] = s.body[0];
    if (!state.world && (x < 0 || y < 0 || x >= state.width || y >= state.height)) { dead.set(s.id, "撞墙"); continue; }
    const k = x + "," + y;
    if (bodyCount.get(k)) {
      const self = s.body.slice(1).some(([bx, by]) => bx === x && by === y);
      dead.set(s.id, self ? "咬到自己" : "撞上别人的身子");
      continue;
    }
    for (const o of movers) {
      if (o.id === s.id) continue;
      const [ox, oy] = o.body[0];
      if (ox === x && oy === y) {
        if (config.brawl) { dead.set(s.id, "撞头，一起出局"); break; }
        if (s.body.length > o.body.length) continue;
        dead.set(s.id, s.body.length === o.body.length ? "撞头，一样长，一起出局" : "撞头，比对方短");
      }
    }
  }
  for (const [id, reason] of dead) {
    const s = state.snakes.find((q) => q.id === id);
    s.alive = false;
    s.deathTurn = state.turn;
    s.deathReason = reason;
    state.events.push({ type: "die", id, reason, at: s.body[0] });
  }
  if (config.brawl && dead.size) dropRemains(state, [...dead.keys()]);
  // 同一拍两条各吃一个雪花，不互相冻；吃的那条这一拍要是撞死了，雪花照样生效。
  if (freezers.length) {
    const until = state.turn + FREEZE_TURNS;
    const hit = alive.filter((o) => o.alive && !freezers.includes(o.id));
    for (const o of hit) o.frozenUntil = Math.max(o.frozenUntil || 0, until);
    state.events.push({ type: "freeze", by: freezers, ids: hit.map((o) => o.id), until });
  }

  if (state.world) refreshWorld(state, config);
  else fillFood(state, config.foodCount);
  refreshRewards(state, config);

  const left = state.snakes.filter((s) => s.alive);
  const multi = state.snakes.length > 1;
  if (config.victory) {
    if (!left.length) finishGame(state, config, "all_dead");
    else if (config.victory === "survival" && multi && left.length === 1) finishGame(state, config, "elimination");
    else if (state.turn >= config.maxTurns || (!state.world && state.food.length === 0)) finishGame(state, config, "limit");
  } else if ((multi && left.length <= 1) || left.length === 0 || state.turn >= config.maxTurns || (!state.world && state.food.length === 0 && left.length)) {
    state.over = true;
    state.winner = pickWinner(state, multi);
    state.events.push({ type: "over", winner: state.winner });
  }
  return state;
}

// Deadlines are external facts recorded in the replay, never read from a clock here.
export function finishGame(state, config, reason = "time") {
  if (state.over) return state;
  const alive = state.snakes.filter(s => s.alive);
  const pool = config.victory === "score" ? state.snakes : alive;
  let winner = null;
  if (config.victory === "survival" && alive.length === 1) winner = alive[0].id;
  else if (pool.length && !(config.victory === "survival" && reason === "all_dead")) {
    const top = Math.max(...pool.map(s => s.score));
    const best = pool.filter(s => s.score === top);
    if (best.length === 1) winner = best[0].id;
  }
  state.over = true;
  state.winner = winner;
  if (config.victory) state.endReason = reason;
  state.events.push({type: "over", winner});
  return state;
}

function pickWinner(state, multi) {
  if (!multi) return null;
  const left = state.snakes.filter((s) => s.alive);
  if (left.length === 1) return left[0].id;
  const pool = left.length ? left : state.snakes.filter((s) => s.deathTurn === state.turn);
  const best = [...pool].sort((a, b) => b.body.length - a.body.length || b.score - a.score);
  if (best.length > 1 && best[0].body.length === best[1].body.length && best[0].score === best[1].score) return null;
  return best[0] ? best[0].id : null;
}

// 从记录重放到第 n 回合（不给 n 就放到最后）。
export function replay(game, upTo) {
  const state = createState(game.config);
  const n = upTo == null ? game.moves.length : Math.min(upTo, game.moves.length);
  for (let i = 0; i < n && !state.over; i++) step(state, game.config, game.moves[i]);
  if (game.config.victory && game.ended?.reason === "time" && state.turn >= game.ended.turn)
    finishGame(state, game.config, "time");
  return state;
}

export function newGame(opts) {
  const config = newConfig(opts);
  return { format: FORMAT, config, moves: [], says: {}, createdAt: new Date().toISOString() };
}

// 给 AI 看的字符棋盘。asId 是「你」那条蛇。
export function renderText(state, config, asId) {
  const letters = {};
  config.players.forEach((p, i) => {
    let L = SKINS[p.skin]?.letter || "K";
    if (Object.values(letters).includes(L)) L = "KCFGBHXYZ".split("").find(c => !Object.values(letters).includes(c));
    letters[p.id] = L;
  });
  const view = viewportFor(state, asId);
  const visible = (x, y) => x >= view.x && y >= view.y && x < view.x + view.width && y < view.y + view.height;
  const grid = Array.from({ length: view.height }, () => Array(view.width).fill("."));
  for (const [x, y] of state.food) if (visible(x,y)) grid[y - view.y][x - view.x] = "*";
  for (const r of state.rewards || []) if (visible(r.x,r.y)) grid[r.y - view.y][r.x - view.x] = rewardMark(r.kind);
  for (const [x, y] of state.remains || []) if (visible(x,y)) grid[y - view.y][x - view.x] = "@";
  for (const s of state.snakes) {
    if (!s.alive) continue;
    const L = letters[s.id];
    s.body.forEach(([x, y], i) => {
      if (visible(x,y)) grid[y - view.y][x - view.x] = i === 0 ? L : L.toLowerCase();
    });
  }
  const labelWidth = Math.max(2, String(view.y).length, String(view.y + view.height - 1).length);
  const pad = n => String(n).padStart(labelWidth, " ");
  const margin = " ".repeat(labelWidth + 2);
  const tens = margin + Array.from({ length: view.width }, (_, i) => {const x = i + view.x; return Math.abs(x) >= 10 ? Math.floor(Math.abs(x) / 10) % 10 : " ";}).join("");
  const ones = margin + Array.from({ length: view.width }, (_, i) => Math.abs(i + view.x) % 10).join("");
  const rows = grid.map((r, y) => pad(y + view.y) + " |" + r.join("") + "|");
  const edge = " ".repeat(labelWidth + 1) + "+" + "-".repeat(view.width) + "+";

  const me = state.snakes.find((s) => s.id === asId);
  const lines = [];
  lines.push(`回合 ${state.turn}${state.over ? "（已结束）" : ""}`);
  if (state.world) lines.push(`漫游视野：全局 x=${view.x}..${view.x + view.width - 1}，y=${view.y}..${view.y + view.height - 1}；只显示附近，世界没有外墙、不穿回另一边。`);
  if (config.victory) lines.push(config.victory === "score" ? "限时积分赛：到时比所有参赛者的累计得分（包括已淘汰者），同分平局；撞死淘汰、不复活。" : "生存赛：最后存活者获胜，同时全灭平局。");
  if (config.brawl && state.snakes.length > 1) lines.push(`大作战规矩：撞上别人的身子出局；头碰头（同一拍进同一格）不分长短一起出局，那一格的糖谁也吃不到。蛇死了身子每一节变一颗大糖 @，一颗 ${REMAINS_VALUE} 分，谁抢到算谁的。`);
  for (const s of state.snakes) {
    const tag = s.id === asId ? "你" : "对手";
    const head = s.body[0];
    let st = s.alive ? `头在 (${head[0]},${head[1]})，朝 ${s.dir}` : `第 ${s.deathTurn} 回合出局：${s.deathReason}`;
    if (s.alive && (s.frozenUntil || 0) > state.turn) st += `，被冻住还剩 ${s.frozenUntil - state.turn} 回合`;
    if (s.alive && (s.doubleUntil || 0) > state.turn) st += `，双倍得分还剩 ${s.doubleUntil - state.turn} 回合`;
    lines.push(`${tag} ${letters[s.id]}=${s.name}：长 ${s.body.length}，吃了 ${s.score} 颗，${st}`);
  }
  lines.push(`南瓜糖 *：${state.food.filter(([x,y]) => visible(x,y)).map(([x, y]) => `(${x},${y})`).join(" ") || "没有了"}`);
  if (config.powerups) {
    lines.push(`道具：%双倍樱桃=吃到后 ${DOUBLE_TURNS} 回合得分翻倍；~冻结雪花=吃到后其他蛇原地定住 ${FREEZE_TURNS} 回合，定住的蛇不动、不吃、不会死，整条身子连头都是墙，撞上去的出局；被冻住时你排好的路线等解冻再接着走。`);
    lines.push("奖励 +金南瓜=3分、$糖果袋=5分、&大奖皇冠=10分、%双倍樱桃、~冻结雪花：" + ((state.rewards || []).filter(r => visible(r.x,r.y)).map(r => `${rewardMark(r.kind)}(${r.x},${r.y})剩${r.expiresAt - state.turn}步`).join(" ") || "暂未出现"));
  } else if (config.rewards) lines.push("奖励 +金南瓜=3分、$糖果袋=5分：" + ((state.rewards || []).filter(r => visible(r.x,r.y)).map(r => `${r.kind === "gold" ? "+" : "$"}(${r.x},${r.y})剩${r.expiresAt - state.turn}步`).join(" ") || "暂未出现"));
  if (state.remains && state.remains.length) {
    const shown = state.remains.filter(([x, y]) => visible(x, y));
    lines.push(`大糖 @：视野里 ${shown.length} 颗`);
  }
  if (me && me.alive && !state.over) {
    const near = nearestTargets(state, config, me.body[0], 3);
    if (near.length) lines.push("从你现在的头算，最近的：" + near.map(describeTarget).join("；"));
  }
  lines.push(tens.trimEnd() ? tens : "", ones, edge, ...rows, edge);
  lines.push(
    "坐标 (x,y)：x 往右变大，y 往下变大。大写字母是头，小写是身子，" +
      (state.world ? "地图没有外墙，坐标不回绕；屏幕外的身体同样会撞到。" : config.wrap ? "这局能穿墙：从一边出去会从对面进来，只有咬到身子才出局。" : "出边框就撞墙。"),
  );
  if (me && me.alive && !state.over)
    lines.push("出手用 U上 D下 L左 R右，可以一次给一串，比如 RRUU；不能直接掉头。");
  if (state.over) {
    const w = state.snakes.find((s) => s.id === state.winner);
    lines.push(state.snakes.length > 1 ? (w ? `赢家：${w.name}` : "平局") : `这局吃了 ${state.snakes[0].score} 颗`);
  }
  return lines.filter((l) => l !== "").join("\n");
}
