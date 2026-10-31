import { newGame, createState, step, viewportFor, finishGame } from "./engine.js?v=20261031e";
import { PAL, SKIN_LOOK, PUMPKIN, GHOST, drawSprite } from "./sprites.js?v=20261031e";
import { drawSnake as paintSnake, headIcon, drawRewards, drawRemains, inViewport } from "./draw.js?v=20261031e";
import { loadSkins, lookFromSkin, decodeSkin, addSkin } from "./skin.js?v=20261031e";
import { initRooms } from "./rooms.js?v=20261031e";

const VERSION = "10/31 e";

const CELL = 10;
const PAD = 6;
const INDEX_URL = new URLSearchParams(location.search).get("index") || "./replays/index.json";

const $ = (s) => document.querySelector(s);
const canvas = $("#board");
const ctx = canvas.getContext("2d");

let mode = "menu"; // menu | play | watch | room | rooms
let game = null; // { config, moves, says }
let state = null;
let effects = [];
let lastEat = {}; // 蛇id -> 吃到糖的时刻
let timer = 0;
let last = performance.now();

// 人玩
let inputQueue = [];
let me = "crab"; // 这一局里她那条蛇的 id
let lastChoice = "crab"; // 「再来一局」用：内置皮肤名，或者 custom:序号
let customLooks = {}; // 蛇 id -> 捏出来的皮肤
let tickMs = 180;
let roomPlayerId = null;
let followId = null;
let camera = { x: 0, y: 0, width: 15, height: 15 };
let started = false; // 等她先给一个方向再出发
let wrapOn = localStorage.getItem("ai-snake-wrap") !== "0"; // 默认能穿墙

// 看 AI 玩
let watchUrl = null;
let cursor = 0;
let paused = false;
let speed = 1;
let pollAt = 0;
let lastFetchedLen = -1;

function fit() {
  camera = state ? viewportFor(state, followId) : { x: 0, y: 0, width: 15, height: 15 };
  const cols = camera.width, rows = camera.height;
  const w = cols * CELL + PAD * 2, h = rows * CELL + PAD * 2;
  canvas.width = w;
  canvas.height = h;
  const reserve = mode === "room" ? 300 : mode === "play" ? 230 : 190;
  const maxW = Math.min(window.innerWidth - 16, 560);
  const maxH = window.innerHeight - reserve;
  const scale = Math.max(0.25, Math.floor(Math.min(maxW / w, Math.max(140, maxH) / h) * 4) / 4);
  canvas.style.width = Math.floor(w * scale) + "px";
  canvas.style.height = Math.floor(h * scale) + "px";
}
window.addEventListener("resize", fit);

// ---------- 画面 ----------

function drawBoard(t) {
  const { width, height } = camera;
  ctx.fillStyle = PAL.Z;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      ctx.fillStyle = (x + camera.x + y + camera.y) % 2 ? "#151b45" : "#121840";
      ctx.fillRect(PAD + x * CELL, PAD + y * CELL, CELL, CELL);
    }
  // 能穿墙的局，边框画成一圈慢慢流动的紫色虚线，看着像能钻过去
  if (!state.world && game && game.config.world !== "roam" && game.config.wrap) {
    const x0 = PAD - 2, y0 = PAD - 2, x1 = PAD + width * CELL + 1, y1 = PAD + height * CELL + 1;
    const shift = Math.floor(t / 120);
    ctx.fillStyle = "#7b6fd0";
    for (let x = x0; x <= x1; x++) if ((x + shift) % 4 < 2) { ctx.fillRect(x, y0, 1, 1); ctx.fillRect(x, y1, 1, 1); }
    for (let y = y0; y <= y1; y++) if ((y + shift) % 4 < 2) { ctx.fillRect(x0, y, 1, 1); ctx.fillRect(x1, y, 1, 1); }
  }
  // 左上角一张蜘蛛网
  ctx.fillStyle = "rgba(142,149,189,.35)";
  for (let i = 0; i < 22; i++) {
    ctx.fillRect(PAD + i, PAD, 1, 1);
    ctx.fillRect(PAD, PAD + i, 1, 1);
    ctx.fillRect(PAD + Math.floor(i * 0.7), PAD + Math.floor(i * 0.7), 1, 1);
  }
  for (const r of [7, 13, 19]) for (let a = 0; a <= 16; a++) {
    const th = (a / 16) * (Math.PI / 2);
    ctx.fillRect(PAD + Math.round(Math.cos(th) * r), PAD + Math.round(Math.sin(th) * r), 1, 1);
  }
  // 南瓜糖，轻轻上下浮
  state.food.forEach(([x, y], i) => {
    if (!inViewport([x, y], camera)) return;
    const bob = Math.sin(t / 260 + i * 1.7) > 0.3 ? -1 : 0;
    const [px, py] = cellXY([x, y]);
    drawSprite(ctx, PUMPKIN, px, py + 1 + bob);
  });
  drawRewards(ctx, state.rewards, cellXY, { t, turn: state.turn, viewport: camera });
  drawRemains(ctx, state.remains, cellXY, { t, viewport: camera });
}

function cellXY([x, y]) { return [PAD + (x - camera.x) * CELL, PAD + (y - camera.y) * CELL]; }

function lookOf(s) {
  return (s && customLooks[s.id]) || (s && SKIN_LOOK[s.skin]) || SKIN_LOOK.crab;
}

function drawSnake(s, t) {
  const happy = Boolean(lastEat[s.id] && t - lastEat[s.id] < 600);
  paintSnake(ctx, lookOf(s), s.body, cellXY, { t, happy, viewport: camera });
  // 被冻住：整条蒙一层冰蓝。
  if ((s.frozenUntil || 0) > state.turn) {
    ctx.fillStyle = "rgba(155, 231, 255, 0.45)";
    for (const cell of s.body) if (inViewport(cell, camera)) { const [x, y] = cellXY(cell); ctx.fillRect(x, y, CELL, CELL); }
  }
  // 金身：整条罩一层会流动的金光，外加一串往尾巴跑的亮点；最后 2 回合快闪，提醒快没了。
  const guardLeft = (s.guardUntil || 0) - state.turn;
  if (guardLeft > 0 && !(guardLeft <= 2 && Math.floor(t / 120) % 2)) {
    const shift = Math.floor(t / 120);
    s.body.forEach((cell, i) => {
      if (!inViewport(cell, camera)) return;
      const [x, y] = cellXY(cell);
      ctx.fillStyle = `rgba(255, 214, 63, ${0.3 + 0.25 * (0.5 + 0.5 * Math.sin(t / 110 - i * 0.7))})`;
      ctx.fillRect(x, y, CELL, CELL);
      ctx.strokeStyle = "rgba(255, 243, 176, 0.9)"; ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
      if ((i + shift) % 3 === 0) { ctx.fillStyle = "#fffbe0"; ctx.fillRect(x + 2, y + 2, 2, 2); ctx.fillRect(x + 6, y + 6, 1, 1); }
    });
  }
  if (state.snakes.length > 1 && s.body.length && inViewport(s.body[0], camera)) {
    const i = state.snakes.findIndex((snake) => snake.id === s.id);
    const [x, y] = cellXY(s.body[0]);
    ctx.fillStyle = ["#f6bb72", "#a9dbff", "#b4edac", "#f2aac8", "#c7b3ff", "#ffe37b"][i % 6];
    ctx.fillRect(x + 6, y - 3, 5, 6);
    ctx.fillStyle = PAL.Z;
    ctx.font = "6px monospace";
    ctx.fillText(String(i + 1), x + 7, y + 2);
    if (s.id === roomPlayerId) { ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1; ctx.strokeRect(x, y, CELL, CELL); }
  }
}

function drawEffects(t) {
  effects = effects.filter((e) => t - e.t0 < e.life);
  for (const e of effects) {
    if (!inViewport(e.at, camera, 3)) continue;
    const [x, y] = cellXY(e.at);
    const k = (t - e.t0) / e.life;
    if (e.kind === "spark") {
      ctx.fillStyle = k < 0.5 ? PAL.G : PAL.S;
      const r = 2 + Math.floor(k * 7);
      const [cx, cy] = [x + 5, y + 5];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const rr = dx && dy ? Math.round(r * 0.7) : r;
        ctx.fillRect(cx + dx * rr, cy + dy * rr, 1, 1);
      }
    } else if (e.kind === "ghost") {
      const rise = Math.floor(k * 22);
      const sway = Math.round(Math.sin(k * 9) * 2);
      drawSprite(ctx, GHOST, x + sway, y - 2 - rise, null, 1 - k * 0.8);
    }
  }
}

function render(t) {
  if (!state) return;
  camera = viewportFor(state, followId);
  drawBoard(t);
  paintCameraOrigin();
  for (const s of state.snakes) if (s.alive) drawSnake(s, t);
  drawEffects(t);
}

function updateHud() {
  const box = $("#players");
  box.innerHTML = "";
  if (!state) return;
  for (const s of state.snakes) {
    const chip = document.createElement("span");
    chip.className = "chip" + (s.alive ? "" : " out");
    chip.append(headIcon(lookOf(s)));
    const label = document.createElement("span");
    label.style.color = lookOf(s).label;
    const status = !s.alive ? "" : `${(s.doubleUntil || 0) > state.turn ? ` ×2 剩${s.doubleUntil - state.turn}` : ""}${(s.frozenUntil || 0) > state.turn ? ` ❄${s.frozenUntil - state.turn}` : ""}${(s.guardUntil || 0) > state.turn ? ` 金身${s.guardUntil - state.turn}` : ""}`;
    label.textContent = `${state.snakes.length > 1 ? (state.snakes.indexOf(s) + 1) + " · " : ""}${s.name}${s.id === roomPlayerId ? "（你）" : ""} ${s.score}${status}`;
    chip.append(label);
    box.append(chip);
  }
  $("#turn").textContent = state.turn ? `第 ${state.turn} 回合` : "";
  paintCameraControls();
}

function absorbEvents(t) {
  for (const e of state.events || []) {
    if (e.type === "eat") {
      lastEat[e.id] = t;
      effects.push({ kind: "spark", at: [...e.at], t0: t, life: 360 });
    } else if (e.type === "die") {
      const at = state.world ? [...e.at] : e.at.map((v, i) => Math.max(0, Math.min(v, (i ? state.height : state.width) - 1)));
      effects.push({ kind: "ghost", at, t0: t, life: 1400 });
    }
  }
  updateHud();
}

function paintCameraOrigin() {
  if (!state?.world) return;
  $("#camera-origin").textContent = `全局原点 (${camera.x}, ${camera.y}) · 已加载 ${state.world.chunks.length} 区块`;
}

function paintCameraControls() {
  const roam = !!state?.world;
  $("#camera-tools").classList.toggle("hidden", !roam || !["room", "watch"].includes(mode));
  if (!roam) return;
  if (!state.snakes.some((s) => s.id === followId)) followId = roomPlayerId || state.snakes.find((s) => s.alive)?.id || state.snakes[0]?.id;
  const select = $("#camera-follow");
  const signature = JSON.stringify(state.snakes.map((s) => [s.id, s.name, s.alive]));
  if (select.dataset.roster !== signature) {
    select.replaceChildren();
    for (const [i, snake] of state.snakes.entries()) {
      const option = document.createElement("option");
      option.value = snake.id;
      option.textContent = `${i + 1} · ${snake.name}${snake.alive ? "" : "（已出局）"}`;
      select.append(option);
    }
    select.dataset.roster = signature;
  }
  select.value = followId;
  camera = viewportFor(state, followId);
  paintCameraOrigin();
}
$("#camera-follow").onchange = (event) => { followId = event.target.value; camera = viewportFor(state, followId); paintCameraOrigin(); };

// ---------- 字幕 ----------

let captionTimer = 0;
function say(id, text) {
  const s = state.snakes.find((q) => q.id === id);
  const look = lookOf(s);
  const el = $("#caption");
  el.innerHTML = "";
  const b = document.createElement("b");
  b.style.color = look.label;
  b.textContent = (s ? s.name : id) + "：";
  el.append(b, document.createTextNode(text));
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { el.innerHTML = ""; }, 3200 / speed + 600);
}

// ---------- 模式切换 ----------

function show(id) {
  for (const o of ["#menu", "#games", "#result"]) $(o).classList.toggle("hidden", o !== id);
}

function toMenu() {
  rooms.stop();
  roomPlayerId = null;
  followId = null;
  mode = "menu";
  history.replaceState(null, "", location.pathname);
  $("#pad").classList.add("hidden");
  $("#watchbar").classList.add("hidden");
  $("#thinking").classList.add("hidden");
  $("#caption").innerHTML = "";
  const best = Number(localStorage.getItem("ai-snake-best") || 0);
  $("#best").textContent = (best ? `你的最好成绩：${best} 颗 · ` : "") + `版本 ${VERSION}`;
  paintCustomRow();
  // 菜单后面放一局没人动的小场景
  customLooks = {};
  game = newGame({ seed: 1031, players: Object.keys(SKIN_LOOK).slice(0, 2).map((skin) => ({ id: skin, skin })) });
  state = createState(game.config);
  fit();
  updateHud();
  show("#menu");
}

// 菜单里列出手机上存着的捏好的皮肤
function paintCustomRow() {
  const row = $("#custom-row");
  row.innerHTML = "";
  loadSkins().forEach((skin, i) => {
    const b = document.createElement("button");
    b.className = "btn warm skin-btn";
    b.append(headIcon(lookFromSkin(skin)), document.createTextNode("我来玩 · " + skin.name));
    b.onclick = () => startPlay("custom:" + i);
    row.append(b);
  });
  row.classList.toggle("hidden", !row.children.length);
}

function startPlay(choice) {
  rooms.stop();
  mode = "play";
  lastChoice = choice;
  customLooks = {};
  let player;
  if (choice.startsWith("custom:")) {
    const skin = loadSkins()[Number(choice.slice(7))];
    if (!skin) return toMenu();
    me = "me";
    customLooks[me] = lookFromSkin(skin);
    // 规则引擎只认内置皮肤；捏的皮肤画在网页上，引擎那边借小螃蟹的字母
    player = { id: me, skin: "crab", name: skin.name };
  } else {
    me = choice;
    player = { id: choice, skin: choice };
  }
  game = newGame({ players: [player], wrap: wrapOn });
  state = createState(game.config);
  inputQueue = [];
  tickMs = 180;
  timer = 0;
  started = false;
  effects = [];
  lastEat = {};
  show(null);
  $("#pad").classList.remove("hidden");
  $("#watchbar").classList.add("hidden");
  $("#caption").textContent = "滑一下屏幕，或者按下面的方向键，就出发";
  fit();
  updateHud();
}

async function openList() {
  show("#games");
  const list = $("#game-list");
  list.innerHTML = "<p>正在翻……</p>";
  try {
    const res = await fetch(INDEX_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const items = await res.json();
    list.innerHTML = "";
    if (!items.length) list.innerHTML = "<p>还没有对局</p>";
    for (const it of items) {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = `${it.title}${it.note ? " · " + it.note : ""}`;
      b.onclick = () => startWatch(it.url);
      list.append(b);
    }
  } catch {
    list.innerHTML = "<p>还没有对局</p>";
  }
}

async function fetchGame(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("读不到这一局：" + res.status);
  return res.json();
}

async function startWatch(url) {
  rooms.stop();
  try {
    const g = await fetchGame(url);
    mode = "watch";
    watchUrl = url;
    game = g;
    history.replaceState(null, "", location.pathname + "?watch=" + encodeURIComponent(url));
    restartWatch();
    show(null);
    $("#pad").classList.add("hidden");
    $("#watchbar").classList.remove("hidden");
  } catch (err) {
    $("#caption").textContent = String(err.message || err);
  }
}

function restartWatch() {
  followId = null;
  customLooks = {};
  for (const player of game.players || game.config.players || []) {
    if (player.skinCode) {
      try { customLooks[player.id] = lookFromSkin(decodeSkin(player.skinCode)); } catch { /* old or invalid code */ }
    }
  }
  state = createState(game.config);
  cursor = 0;
  paused = false;
  timer = 0;
  effects = [];
  lastEat = {};
  lastFetchedLen = game.moves.length;
  $("#w-pause").textContent = "暂停";
  $("#caption").innerHTML = "";
  show(null);
  fit();
  updateHud();
}

function finish() {
  const multi = state.snakes.length > 1;
  let title, detail;
  if (mode === "play") {
    const s = state.snakes[0];
    const best = Math.max(s.score, Number(localStorage.getItem("ai-snake-best") || 0));
    localStorage.setItem("ai-snake-best", String(best));
    title = `吃了 ${s.score} 颗南瓜糖`;
    detail = `${s.deathReason || "地图吃满了"}${game.config.wrap ? "（这局开着穿墙）" : ""} · 最好成绩 ${best} 颗`;
    $("#again").textContent = "再来一局";
  } else {
    const w = state.snakes.find((s) => s.id === state.winner);
    title = multi ? (w ? `${w.name} 赢了` : "平局") : `${state.snakes[0].name} 吃了 ${state.snakes[0].score} 颗`;
    detail = state.snakes.map((s) => `${s.name}：${s.score} 颗${s.alive ? "" : "，" + s.deathReason}`).join(" · ") + ` · 共 ${state.turn} 回合`;
    if (game.config.victory) detail = `${game.config.victory === "score" ? "限时得分" : "生存赛"} · ${game.config.world === "roam" ? "无限漫游" : "竞技场"} · ${detail}`;
    if (game.ended) detail += ` · ${game.ended.reason === "time" ? "时间到" : game.ended.reason}`;
    $("#again").textContent = "再看一遍";
  }
  $("#result-title").textContent = title;
  $("#result-detail").textContent = detail;
  const finishedState = state;
  setTimeout(() => { if (state === finishedState && state.over && ["play", "watch"].includes(mode)) show("#result"); }, 1300);
}

// ---------- 每一帧 ----------

function frame(t) {
  const dt = Math.min(100, t - last);
  last = t;
  if (mode === "play" && started && !state.over) {
    timer += dt;
    if (timer >= tickMs) {
      timer = 0;
      const d = inputQueue.shift();
      const mv = d ? { [me]: d } : {};
      game.moves.push(mv);
      step(state, game.config, mv);
      absorbEvents(t);
      if (state.events.some((e) => e.type === "eat")) tickMs = Math.max(100, tickMs - 4);
      if (state.over) finish();
    }
  } else if (mode === "watch" && !paused && !state.over) {
    timer += dt * speed;
    if (game.config.victory && game.ended?.reason === "time" && state.turn >= game.ended.turn) {
      finishGame(state, game.config, "time");
      finish();
    } else if (cursor < game.moves.length) {
      $("#thinking").classList.add("hidden");
      if (timer >= 220) {
        timer = 0;
        const said = game.says && game.says[cursor];
        step(state, game.config, game.moves[cursor]);
        if (said) for (const [id, text] of Object.entries(said)) say(id, text);
        cursor++;
        if (game.config.victory && game.ended?.reason === "time" && state.turn >= game.ended.turn && !state.over) finishGame(state, game.config, "time");
        absorbEvents(t);
        if (state.over) finish();
      }
    } else if (game.ended) {
      state.over = true;
      finish();
    } else if (t > pollAt) {
      // 播到头了、这局还没完：AI 还在下，过一会儿再去拿新的出手
      $("#thinking").classList.remove("hidden");
      pollAt = t + 1000;
      const fetchedUrl = watchUrl;
      fetchGame(fetchedUrl).then((g) => {
        if (mode !== "watch" || watchUrl !== fetchedUrl || !g.moves) return;
        if (g.moves.length !== lastFetchedLen) { game.moves = g.moves; game.says = g.says || {}; lastFetchedLen = g.moves.length; }
        if (g.ended) game.ended = g.ended;
      }).catch(() => {});
    }
  }
  render(t);
  requestAnimationFrame(frame);
}

// ---------- 操作 ----------

const OPP = { U: "D", D: "U", L: "R", R: "L" };
function push(dir) {
  if (mode === "room") return rooms.sendDirection(dir);
  if (mode !== "play" || state.over) return;
  if (!started) {
    started = true;
    timer = tickMs;
    $("#caption").innerHTML = "";
  }
  const s = state.snakes[0];
  const prev = inputQueue.length ? inputQueue[inputQueue.length - 1] : s.dir;
  if (dir === prev || dir === OPP[prev]) return;
  if (inputQueue.length < 3) inputQueue.push(dir);
}

const KEYS = { ArrowUp: "U", ArrowDown: "D", ArrowLeft: "L", ArrowRight: "R", w: "U", s: "D", a: "L", d: "R", W: "U", S: "D", A: "L", D: "R" };
window.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (KEYS[e.key] && ["play", "room"].includes(mode)) { e.preventDefault(); push(KEYS[e.key]); }
  if (e.key === " " && mode === "watch") togglePause();
});

let touch0 = null;
canvas.addEventListener("touchstart", (e) => { if (["play", "room"].includes(mode)) touch0 = [e.touches[0].clientX, e.touches[0].clientY]; }, { passive: true });
canvas.addEventListener("touchmove", (e) => {
  if (!touch0 || !["play", "room"].includes(mode)) return;
  const dx = e.touches[0].clientX - touch0[0], dy = e.touches[0].clientY - touch0[1];
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  push(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "R" : "L") : (dy > 0 ? "D" : "U"));
  touch0 = [e.touches[0].clientX, e.touches[0].clientY];
}, { passive: true });
document.addEventListener("touchend", () => { touch0 = null; });

for (const b of document.querySelectorAll("#pad button")) b.addEventListener("pointerdown", (e) => { e.preventDefault(); push(b.dataset.dir); });
for (const [skin, look] of Object.entries(SKIN_LOOK)) {
  if (skin === "crab") continue;
  const b = document.createElement("button");
  b.className = "btn warm skin-btn";
  b.dataset.play = skin;
  b.append(headIcon(look), document.createTextNode("我来玩 · " + look.name));
  $("#private-play").append(b);
}

for (const b of document.querySelectorAll("[data-play]")) b.onclick = () => startPlay(b.dataset.play);
for (const b of document.querySelectorAll("[data-menu]")) b.onclick = toMenu;
$("#open-list").onclick = openList;
$("#open-rooms").onclick = () => rooms.open("create");
$("#open-live").onclick = () => rooms.open("live");
$("#open-ranking").onclick = () => rooms.open("rank");
function paintWrap() { $("#wrap-toggle").textContent = wrapOn ? "穿墙：开" : "穿墙：关（撞墙就输）"; }
$("#wrap-toggle").onclick = () => {
  wrapOn = !wrapOn;
  localStorage.setItem("ai-snake-wrap", wrapOn ? "1" : "0");
  paintWrap();
};
paintWrap();
$("#again").onclick = () => (mode === "play" ? startPlay(lastChoice) : restartWatch());

function togglePause() {
  paused = !paused;
  $("#w-pause").textContent = paused ? "继续" : "暂停";
}
$("#w-pause").onclick = togglePause;
$("#w-speed").onclick = () => {
  speed = speed === 1 ? 2 : speed === 2 ? 0.5 : 1;
  $("#w-speed").textContent = speed === 0.5 ? "慢放" : speed + " 倍速";
};
$("#w-restart").onclick = restartWatch;

// 别人发来的皮肤链接：?skin=SNK1.… 收进手机里，菜单上就多一个按钮
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 3600);
}

const rooms = initRooms({
  onBrowse() {
    mode = "rooms";
    effects = [];
    lastEat = {};
    roomPlayerId = null;
    followId = null;
    $("#camera-tools").classList.add("hidden");
    show(null);
    $("#pad").classList.add("hidden");
    $("#watchbar").classList.add("hidden");
    $("#thinking").classList.add("hidden");
    $("#caption").textContent = "";
    clearTimeout(captionTimer);
  },
  onSnapshot(room, own) {
    const previous = state;
    const previousMode = mode;
    mode = "room";
    roomPlayerId = own?.id || null;
    if (previousMode !== "room" || !followId) followId = roomPlayerId || room.state.snakes.find((s) => s.alive)?.id || room.state.snakes[0]?.id;
    game = { config: room.config };
    state = room.state;
    customLooks = {};
    for (const player of room.players) {
      if (player.skinCode) {
        try { customLooks[player.id] = lookFromSkin(decodeSkin(player.skinCode)); } catch { /* external skin falls back */ }
      }
    }
    $("#pad").classList.toggle("hidden", !(own?.kind === "human" && room.status === "running" && state.snakes.find((s) => s.id === own.id)?.alive));
    if (previousMode !== "room" || !previous || previous.width !== state.width || previous.height !== state.height) fit();
    if (!previous || previous.turn !== state.turn) absorbEvents(performance.now());
    else updateHud();
  },
  onMenu: toMenu,
  onReplay(replay, url) {
    mode = "watch";
    roomPlayerId = null;
    game = replay;
    watchUrl = url;
    history.replaceState(null, "", location.pathname + "?watch=" + encodeURIComponent(url));
    restartWatch();
    $("#pad").classList.add("hidden");
    $("#watchbar").classList.remove("hidden");
  },
  notice: toast,
});

const params = new URLSearchParams(location.search);
const watchParam = params.get("watch");
const roomParam = params.get("room");
let playParam = params.get("play");
if (params.get("skin")) {
  try {
    const skin = decodeSkin("?skin=" + params.get("skin"));
    const i = addSkin(skin);
    toast(`收到皮肤「${skin.name}」，菜单里点它就能玩`);
    if (playParam === "skin") playParam = "custom:" + i;
  } catch (err) {
    toast("这个皮肤链接没认出来：" + (err.message || err));
  }
}
toMenu();
if (roomParam) rooms.enter(roomParam);
else if (watchParam) startWatch(watchParam);
else if (playParam && (SKIN_LOOK[playParam] || /^custom:\d+$/.test(playParam))) startPlay(playParam);
requestAnimationFrame(frame);
