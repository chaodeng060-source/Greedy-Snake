import { SKIN_LOOK, ROOM_LABELS } from "./sprites.js?v=20261031b";
import { headIcon } from "./draw.js?v=20261031b";
import { loadSkins, encodeSkin, decodeSkin, lookFromSkin } from "./skin.js?v=20261031b";

const STATUS = { lobby: "等待加入", warming: "AI 正在准备首轮行动", running: "进行中", finished: "已结束" };
const VICTORIES = { survival: "生存赛", score: "限时得分" };
const WORLDS = { arena: "竞技场", roam: "无限漫游" };
const collisionRule = "蛇头撞上任何蛇的身体都会出局；所有蛇在同一回合同时移动、同时判定碰撞。";
function roomRules(victory, world) {
  const victoryRule = victory === "score"
    ? "出局不复活，已得分保留；时间到比较全部参赛者累计得分，同分平局，全部出局则提前结束。AI 思考期间计时继续。"
    : "活到最后获胜；最后同时出局则平局。达到回合上限按存活、得分判定，同分平局。";
  return collisionRule + victoryRule + (world === "roam" ? "漫游没有外墙，不穿墙；屏幕外的身体仍会碰撞。" : "");
}
function roomModes(room) {
  return { victory: room.victory || room.config?.victory || "survival", world: room.world || room.config?.world || "arena" };
}
function modeLabel(room) {
  const { victory, world } = roomModes(room);
  return `${VICTORIES[victory]} · ${WORLDS[world]}`;
}
function countdown(room) {
  if (roomModes(room).victory !== "score") return "";
  if (["lobby", "warming"].includes(room.status)) return `限时 ${room.durationSeconds || room.config.durationSeconds || 60} 秒 · 准备完成后计时`;
  if (!Number.isFinite(room.remainingMs)) return room.status === "finished" ? "本局结束" : "剩余时间同步中";
  const seconds = Math.max(0, Math.ceil(room.remainingMs / 1000));
  return `剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
const OPP = { U: "D", D: "U", L: "R", R: "L" };
const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
const button = (text, action, warm = false) => {
  const el = node("button", "btn" + (warm ? " warm" : ""), text);
  el.type = "button";
  el.onclick = action;
  return el;
};
const requestId = () => globalThis.crypto?.randomUUID?.() || Date.now() + "-" + Math.random().toString(36).slice(2);

// Authentication is sent in POST bodies only. Room links contain just a public id.
export class RoomClient {
  constructor(base, { storage = globalThis.localStorage, fetcher = globalThis.fetch } = {}) {
    const url = new URL(base || "/", globalThis.location?.origin || "http://localhost");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("服务地址只能包含 http(s) 地址与路径");
    }
    this.base = url.href.replace(/\/$/, "");
    this.storage = storage;
    this.fetcher = fetcher.bind(globalThis);
  }
  key(id) { return "ai-snake-seat:" + this.base + ":" + id; }
  seat(id) {
    try { return JSON.parse(this.storage.getItem(this.key(id)) || "{}"); } catch { return {}; }
  }
  remember(data) {
    const id = data.room.id;
    const saved = { ...this.seat(id) };
    for (const key of ["hostToken", "playerId", "token"]) if (data[key]) saved[key] = data[key];
    this.storage.setItem(this.key(id), JSON.stringify(saved));
    return data.room;
  }
  async request(path, body) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), path.endsWith("/start") ? 65000 : 10000);
    try {
      const response = await this.fetcher(this.base + path, {
        method: body == null ? "GET" : "POST", cache: "no-store", signal: abort.signal,
        ...(body == null ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "房间服务返回 " + response.status);
      return data;
    } catch (err) {
      if (err.name === "AbortError") throw new Error("房间服务暂未响应，正在重连");
      throw err;
    } finally { clearTimeout(timeout); }
  }
  async create(config) { return this.remember(await this.request("/rooms", config)); }
  async join(id, player) { return this.remember(await this.request(`/rooms/${encodeURIComponent(id)}/join`, player)); }
  async start(id) { return this.request(`/rooms/${encodeURIComponent(id)}/start`, { hostToken: this.seat(id).hostToken }); }
  async plan(id, moves) {
    const { playerId, token } = this.seat(id);
    if (!playerId || !token) throw new Error("请先加入一个席位");
    return this.request(`/rooms/${encodeURIComponent(id)}/plan`, { playerId, token, moves, requestId: requestId() });
  }
}

export function initRooms({ onBrowse, onSnapshot, onMenu, onReplay, notice }) {
  const directory = document.querySelector("#rooms");
  const bar = document.querySelector("#room-bar");
  const details = document.querySelector("#room-details");
  const meta = document.querySelector('meta[name="ai-snake-api"]');
  let configuredBase = meta ? meta.content : "/api/ai-snake";
  try { configuredBase = localStorage.getItem("ai-snake-api") ?? configuredBase; } catch { /* optional preference */ }
  let client;
  try { client = new RoomClient(configuredBase); } catch { client = new RoomClient("/api/ai-snake"); }
  let current = null;
  let epoch = 0;
  let pollTimer = 0;
  let busy = false;
  let catalogue = [];
  let pendingDirections = [];
  let sending = null;
  let lastInputTurn = -1;
  let plannedDirection = null;
  let settled = false;
  let lastDetailKey = "";
  let leaderboardSelection = "survival:arena";

  function stop() {
    epoch++;
    clearTimeout(pollTimer);
    current = null;
    pendingDirections = [];
    plannedDirection = null;
    lastInputTurn = -1;
    settled = false;
    lastDetailKey = "";
    directory.classList.add("hidden");
    bar.classList.add("hidden");
    details.classList.add("hidden");
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (err) { notice(err.message || "连接房间失败"); }
    finally { busy = false; if (current) paintRoom(true); }
  }
  function schedule(run, delay, generation) {
    if (generation !== epoch) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(run, delay);
  }
  function ownPlayer() {
    return current?.players.find((p) => p.id === client.seat(current.id).playerId);
  }
  function update(snapshot) {
    if (current && current.id !== snapshot.id) return;
    if (current && snapshot.state.turn < current.state.turn) return;
    const previous = current;
    current = snapshot;
    if (!previous || snapshot.state.turn !== previous.state.turn) plannedDirection = null;
    onSnapshot(snapshot, ownPlayer());
    paintRoom();
    flushDirections();
  }
  async function pollRoom(generation) {
    if (!current || generation !== epoch) return;
    const id = current.id;
    try {
      const room = await client.request(`/rooms/${encodeURIComponent(id)}`);
      if (generation !== epoch) return;
      update(room);
      if (room.status === "finished" && !settled) {
        const result = await client.request(`/rooms/${encodeURIComponent(id)}/settlement`);
        if (generation !== epoch) return;
        settled = true;
        current = { ...current, settlement: result.settlement };
        paintRoom(true);
      }
      schedule(() => pollRoom(generation), room.status === "running" ? 180 : 1000, generation);
    } catch {
      if (generation !== epoch) return;
      const status = bar.querySelector(".room-status");
      if (status) status.textContent = "连接中断，正在重连；席位保留";
      schedule(() => pollRoom(generation), 1500, generation);
    }
  }
  async function enter(id, snapshot) {
    stop();
    const generation = epoch;
    directory.classList.add("hidden");
    onBrowse();
    try {
      const room = snapshot || await client.request(`/rooms/${encodeURIComponent(id)}`);
      if (generation !== epoch) return;
      current = null;
      update(room);
      history.replaceState(null, "", location.pathname + "?room=" + encodeURIComponent(room.id));
      bar.classList.remove("hidden");
      details.classList.remove("hidden");
      schedule(() => pollRoom(generation), 200, generation);
    } catch (err) {
      if (generation !== epoch) return;
      notice(err.message || "找不到房间");
      open();
    }
  }
  function share() {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set("room", current.id);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url.href).then(() => notice("房间链接已复制，发给第二位玩家即可加入"), () => window.prompt("复制房间链接", url.href));
    else window.prompt("复制房间链接", url.href);
  }
  function look(player) {
    if (player.skinCode) {
      try { return lookFromSkin(decodeSkin(player.skinCode)); } catch { /* invalid external skin */ }
    }
    return SKIN_LOOK[player.skin] || SKIN_LOOK.crab;
  }
  function identity(player) {
    const span = node("span", "room-ident");
    span.append(headIcon(look(player)), document.createTextNode(player.name + (player.testBot ? " · 测试" : "")));
    return span;
  }
  function paintRoom(force = false) {
    if (!current) return;
    const room = current;
    const saved = client.seat(room.id);
    bar.replaceChildren();
    const row = node("div", "room-row");
    row.append(node("span", "room-status", `房间 ${room.id} · ${STATUS[room.status] || room.status}`));
    row.append(node("span", "room-muted", modeLabel(room) + (room.mode === "ai" ? " · AI 节奏" : " · 真人节奏")));
    if (roomModes(room).victory === "score") { const clock = node("span", "room-countdown", countdown(room)); clock.dataset.countdown = ""; row.append(clock); }
    row.append(button("邀请 / 第二人加入", share), button("大厅", open));
    bar.append(row);
    // Keep focused manual-plan inputs while snapshots arrive.
    const key = JSON.stringify([roomModes(room), room.status, room.players.map((p) => [p.id, p.joined]), saved.playerId, !!saved.hostToken, room.settlement, busy]);
    if (!force && key === lastDetailKey) {
      const queue = details.querySelector("[data-remaining]");
      if (queue) queue.textContent = `已排队 ${room.plans?.[saved.playerId]?.remaining || 0} 步`;
      return;
    }
    lastDetailKey = key;
    details.replaceChildren();
    const rules = node("p", "room-muted", roomRules(roomModes(room).victory, roomModes(room).world));
    rules.id = "room-rules";
    details.append(rules);
    const seats = node("div", "room-card");
    seats.append(node("strong", "", "参赛席位"));
    for (const player of room.players) {
      const line = node("div", "room-row");
      line.append(identity(player));
      const kind = player.kind === "human" ? "真人" : player.provider === "manual" ? ROOM_LABELS.manual : `${player.provider} · ${player.model}`;
      line.append(node("span", "room-muted", `${kind} · ${player.id === saved.playerId ? "你 · " : ""}${player.joined ? "已就位" : "等待加入"}`));
      if (room.status === "lobby" && !player.joined && (!saved.playerId || !saved.token) && (player.kind === "human" || player.provider === "manual")) {
        line.append(button(player.kind === "human" ? "作为第二人加入" : "网页接管手动 AI", () => action(async () => {
          const generation = epoch;
          const snapshot = await client.join(room.id, { kind: player.kind, playerId: player.id });
          if (generation === epoch) update(snapshot);
        }), true));
      }
      if (!player.joined && player.provider === "manual") {
        const command = node("code", "room-muted", `node games/ai-snake/cli.mjs room-join --url ${new URL(client.base, location.origin).href.replace(/\/$/, "")} --room ${room.id} --player ${player.id} --kind ai --session .ai-snake-${room.id}-${player.id}.json`);
        line.append(node("span", "room-muted", "手动 AI 必须先用网页或 CLI 加入，再由房主开局。"), command);
      }
      seats.append(line);
    }
    if (room.status === "lobby") {
      seats.append(node("p", "room-muted", "所有真人和手动 AI 就位后开局。第二位真人请在另一台设备打开邀请链接。"));
      if (saved.hostToken) {
        const start = button(busy ? "正在开局……" : "全部就位，开始", () => action(async () => {
          const response = await client.start(room.id);
          if (current?.id === room.id) update(response.room);
        }), true);
        start.disabled = busy || room.players.some((p) => !p.joined && (p.kind === "human" || p.provider === "manual"));
        seats.append(start);
      } else seats.append(node("p", "room-muted", "等待房主开始"));
    }
    if (room.status === "warming") seats.append(node("p", "room-status", "AI 正在准备行动；准备完成后自动出发。"));
    details.append(seats);
    const own = ownPlayer();
    if (own?.kind === "human" && room.status === "running") details.append(node("p", "room-muted", "滑动棋盘、点方向键或使用键盘方向键 / WASD。你只控制自己的蛇。"));
    if (own?.provider === "manual" && ["lobby", "warming", "running"].includes(room.status)) {
      const manual = node("form", "room-card");
      const input = node("textarea");
      input.placeholder = "输入至少 6 步，例如 RRRUUULLL（U 上 D 下 L 左 R 右）";
      input.rows = 2;
      input.maxLength = 128;
      input.setAttribute("aria-label", "手动 AI 行动队列");
      const remaining = node("span", "room-muted", `已排队 ${room.plans?.[own.id]?.remaining || 0} 步`);
      remaining.dataset.remaining = "";
      const submit = button("追加行动", () => {});
      submit.type = "submit";
      manual.append(remaining, input, submit);
      manual.onsubmit = (event) => {
        event.preventDefault();
        const moves = input.value.toUpperCase().replace(/\s/g, "");
        if (!/^[URDL]{6,128}$/.test(moves)) return notice("手动 AI 每次提交 6–128 个 URDL 方向");
        action(async () => { const result = await client.plan(room.id, moves); input.value = ""; if (current?.id === room.id) update(result.room); });
      };
      details.append(manual);
    }
    if (room.status === "finished") {
      paintSettlement(room);
      const controls = node("div", "room-row");
      controls.append(button("看完整回放", () => action(async () => {
        const url = client.base + `/rooms/${encodeURIComponent(room.id)}/replay`;
        const replay = await client.request(`/rooms/${encodeURIComponent(room.id)}/replay`);
        stop();
        onReplay(replay, url);
      })), button("回大厅再开一局", () => open("create"), true));
      details.append(controls);
    }
  }
  function paintSettlement(room) {
    const box = node("div", "room-card");
    box.append(node("strong", "", "本局结算"));
    const winner = room.players.find((p) => p.id === room.state.winner);
    box.append(node("p", "room-status", `${modeLabel(room)} · ${winner ? winner.name + " 获胜" : "平局"}${room.state.endReason === "time" ? " · 时间到" : ""}`));
    if (roomModes(room).victory === "score") box.append(node("p", "room-muted", "按全部参赛者累计得分排名，已出局仍可获胜；同分平局，无长度加赛。"));
    const settlement = room.settlement;
    const records = Array.isArray(settlement) ? settlement : settlement?.players || settlement?.results || [];
    const table = node("table", "room-table");
    const header = node("tr");
    for (const label of ["参赛者", "得分 / 吃糖", "长度 / 状态", "调用 / Tokens", "错误"]) header.append(node("th", "", label));
    table.append(header);
    const snakes = [...room.state.snakes].sort((a, b) => roomModes(room).victory === "score" ? b.score - a.score : Number(b.alive) - Number(a.alive) || b.score - a.score);
    for (const snake of snakes) {
      const player = room.players.find((p) => p.id === snake.id) || snake;
      const record = records.find?.((p) => (p.playerId || p.id) === snake.id) || {};
      const usage = room.usage?.[snake.id] || record.usage || {};
      const tr = node("tr");
      const name = node("td"); name.append(identity(player)); tr.append(name);
      for (const value of [`${record.score ?? snake.score} / ${record.eaten ?? snake.eaten ?? snake.score}`, `${record.length ?? snake.body.length} / ${snake.alive ? "存活" : snake.deathReason || "出局"}`, `${usage.calls || 0} / ${(usage.promptTokens || 0) + (usage.completionTokens || 0)}`, usage.errors || 0]) tr.append(node("td", "", value));
      table.append(tr);
    }
    const scroll = node("div", "room-table-wrap"); scroll.append(table); box.append(scroll);
    box.append(node("p", "room-muted", `共 ${room.state.turn} 回合 · 金币与宝袋计入本局奖励 · 测试席位不计入排行榜`));
    details.append(box);
  }
  function sendDirection(dir) {
    const own = ownPlayer();
    if (!own || own.kind !== "human" || current.status !== "running" || !current.state.snakes.find((s) => s.id === own.id)?.alive) return;
    const snake = current.state.snakes.find((s) => s.id === own.id);
    const prev = pendingDirections.at(-1) || plannedDirection || snake.dir;
    if (!/^[URDL]$/.test(dir) || dir === prev || dir === OPP[prev] || pendingDirections.length >= 3) return;
    pendingDirections.push(dir);
    flushDirections();
  }
  async function flushDirections() {
    if (!current || sending === epoch || !pendingDirections.length || current.status !== "running" || lastInputTurn === current.state.turn) return;
    const generation = epoch;
    const room = current;
    const own = ownPlayer();
    const snake = room.state.snakes.find((s) => s.id === own?.id);
    if (!snake?.alive) { pendingDirections = []; return; }
    const move = pendingDirections.shift();
    if (move === OPP[snake.dir]) { plannedDirection = null; return; }
    sending = generation;
    lastInputTurn = room.state.turn;
    plannedDirection = move;
    try {
      const response = await client.plan(room.id, move);
      if (generation === epoch) update(response.room);
    } catch (err) {
      if (generation === epoch) { pendingDirections = []; plannedDirection = null; lastInputTurn = -1; notice(err.message || "方向未送达，请重试"); }
    } finally {
      if (sending === generation) sending = null;
      if (generation === epoch && current?.state.turn > lastInputTurn) flushDirections();
    }
  }
  function fillSkinSelect(select) {
    for (const [key, look] of Object.entries(SKIN_LOOK)) {
      const option = node("option", "", look.name); option.value = key; select.append(option);
    }
    loadSkins().forEach((skin, i) => { const option = node("option", "", "自定义 · " + skin.name); option.value = "custom:" + i; select.append(option); });
  }
  function skinFields(value, code) {
    if (code?.trim()) {
      const skin = decodeSkin(code);
      return { skin: "crab", skinCode: encodeSkin(skin) };
    }
    if (value.startsWith("custom:")) {
      const skin = loadSkins()[Number(value.slice(7))];
      if (!skin) throw new Error("皮肤已移除，请重新选择");
      return { skin: "crab", skinCode: encodeSkin(skin) };
    }
    return { skin: value };
  }
  function paintCreate(container) {
    const form = node("form", "room-card");
    form.innerHTML = `<h2>创建房间</h2><div class="room-grid"><label>出手节奏<select name="mode"><option value="mixed">真人 + AI</option><option value="ai">AI 对战</option></select></label><label data-human-field>真人人数<select name="humans"><option value="1">1 人</option><option value="2">2 人 · 另一台设备加入</option></select></label></div><div class="room-grid"><label>胜负规则<select name="victory"><option value="survival">生存赛 · 活到最后</option><option value="score">限时得分 · 累计分数</option></select></label><label>地图<select name="world"><option value="arena">竞技场</option><option value="roam">无限漫游 · 跟随镜头</option></select></label><label data-score-only class="hidden">时长（秒）<input name="durationSeconds" type="number" min="1" max="3600" step="1" list="room-durations" value="60" disabled><datalist id="room-durations"><option value="30"><option value="60"><option value="120"><option value="300"></datalist></label></div><p class="room-muted" data-mode-explanation></p><div data-human-fields class="room-grid"></div><label data-human-field>自己的皮肤码（可选）<textarea name="skinCode" rows="2" placeholder="粘贴 SNK1. 皮肤码；留空使用选择的皮肤"></textarea></label><strong>AI 席位 · 最多 4 个</strong><div data-ai-fields></div><div class="room-grid"><label data-arena-only>穿墙<select name="wrap"><option value="true">开</option><option value="false">关</option></select></label><label data-survival-only>回合上限<input name="maxTurns" type="number" min="1" max="1200" value="600" required></label></div><p class="room-muted">房间对局会刷奖励：金南瓜 +3、糖果袋 +5、皇冠 +10；樱桃让你 10 回合内得分翻倍；雪花让其他蛇原地定住 3 回合（定住的蛇整条当墙，撞上去出局）。创建后手动开局。</p><button class="btn warm" type="submit">创建，进入房间</button>`;
    const humans = form.querySelector("[data-human-fields]");
    for (let i = 0; i < 2; i++) {
      const cell = node("div", "room-card"); cell.dataset.humanIndex = i;
      const label = node("label", "", i ? "第二位真人昵称" : "你的昵称");
      const name = node("input"); name.name = "human-name-" + i; name.maxLength = 24; name.value = "玩家 " + (i + 1); label.append(name);
      const skinLabel = node("label", "", "皮肤"); const select = node("select"); select.name = "human-skin-" + i; fillSkinSelect(select); skinLabel.append(select);
      cell.append(label, skinLabel); humans.append(cell);
    }
    const fields = form.querySelector("[data-ai-fields]");
    const choices = catalogue.length ? catalogue : [{ provider: "opencode", model: "deepseek-v4.1-flash", name: "DeepSeek" }, { provider: "ollama", model: "qwen3:8b", name: "Ollama" }];
    const models = [...choices.filter((m) => m.provider !== "manual"), { provider: "manual", model: "", name: ROOM_LABELS.manual }];
    for (let i = 0; i < 4; i++) {
      const row = node("div", "room-card");
      const label = node("label", "", "AI " + (i + 1)); const select = node("select"); select.name = "ai-" + i;
      const none = node("option", "", "不加入"); none.value = ""; select.append(none);
      models.forEach((model, j) => { const option = node("option", "", model.name || `${model.provider} · ${model.model}`); option.value = j; select.append(option); });
      if (i === 0) select.value = "0";
      label.append(select);
      const modelLabel = node("label", "", "模型名称（可编辑）"); const model = node("input"); model.name = "ai-model-" + i; model.maxLength = 160; modelLabel.append(model);
      const skinLabel = node("label", "", "皮肤"); const skin = node("select"); skin.name = "ai-skin-" + i; fillSkinSelect(skin); skinLabel.append(skin);
      select.onchange = () => { const chosen = models[select.value]; model.value = chosen?.model || ""; modelLabel.classList.toggle("hidden", !chosen || chosen.provider === "manual"); row.classList.toggle("room-unused", !chosen); };
      select.onchange();
      row.append(label, modelLabel, skinLabel); fields.append(row);
    }
    const refreshHumans = () => {
      const count = form.elements.mode.value === "ai" ? 0 : Number(form.elements.humans.value);
      form.querySelectorAll("[data-human-field]").forEach((el) => el.classList.toggle("hidden", !count));
      for (const el of humans.children) el.classList.toggle("hidden", Number(el.dataset.humanIndex) >= count);
    };
    form.elements.mode.onchange = refreshHumans; form.elements.humans.onchange = refreshHumans; refreshHumans();
    const refreshRules = () => {
      const score = form.elements.victory.value === "score";
      const roam = form.elements.world.value === "roam";
      form.querySelector("[data-score-only]").classList.toggle("hidden", !score);
      form.elements.durationSeconds.disabled = !score;
      form.elements.durationSeconds.required = score;
      form.querySelector("[data-survival-only]").classList.toggle("hidden", score);
      form.elements.maxTurns.disabled = score;
      form.elements.maxTurns.required = !score;
      form.querySelector("[data-arena-only]").classList.toggle("hidden", roam);
      form.elements.wrap.disabled = roam;
      form.querySelector("[data-mode-explanation]").textContent = roomRules(form.elements.victory.value, form.elements.world.value);
    };
    form.elements.victory.onchange = refreshRules;
    form.elements.world.onchange = refreshRules;
    refreshRules();
    form.onsubmit = (event) => {
      event.preventDefault();
      action(async () => {
        const data = new FormData(form);
        const mode = data.get("mode");
        const humanCount = mode === "ai" ? 0 : Number(data.get("humans"));
        const humanPlayers = Array.from({ length: humanCount }, (_, i) => ({ name: data.get("human-name-" + i), ...skinFields(data.get("human-skin-" + i), i ? "" : data.get("skinCode")) }));
        const ais = [];
        for (let i = 0; i < 4; i++) {
          const choice = data.get("ai-" + i);
          if (choice === "") continue;
          const selected = models[Number(choice)];
          const model = String(data.get("ai-model-" + i) || "").trim();
          if (selected.provider !== "manual" && !model) throw new Error("请填写 AI 模型名称");
          ais.push({ name: selected.name || model || "手动 AI", provider: selected.provider, model, ...skinFields(data.get("ai-skin-" + i)) });
        }
        if (!ais.length) throw new Error("房间需要至少一个 AI 席位；纯真人可选择一个手动 AI");
        const victory = data.get("victory");
        const world = data.get("world");
        const maxTurns = Number(data.get("maxTurns"));
        const durationSeconds = Number(data.get("durationSeconds"));
        if (victory === "survival" && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 1200)) throw new Error("回合数需要在 1–1200 之间");
        if (victory === "score" && (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600)) throw new Error("时长需要在 1–3600 秒之间");
        const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
        try { const snapshot = await client.create({ mode, victory, world, humans: humanPlayers, ais, wrap: world === "arena" && data.get("wrap") === "true", ...(victory === "score" ? { durationSeconds } : { maxTurns }) }); await enter(snapshot.id, snapshot); }
        finally { submit.disabled = false; }
      });
    };
    container.append(form);
  }
  function paintLeaderboards(container, data) {
    container.replaceChildren();
    function board(title, players) {
      const card = node("section", "room-card");
      card.append(node("h3", "", title));
      if (!players.length) card.append(node("p", "room-muted", "暂无完成的对局"));
      for (const [i, player] of players.entries()) card.append(node("p", "room-muted", `${i + 1}. ${player.name} · 最高 ${player.best} · ${player.wins}/${player.games} 胜 · 拾取 ${player.totalEaten}`));
      return card;
    }
    if (!data.boards) {
      container.append(board("历史总榜", data.players || []));
      return;
    }
    const label = node("label", "", "选择排行榜");
    const select = node("select");
    select.id = "leaderboard-board";
    select.name = "leaderboard-board";
    for (const victory of ["survival", "score"]) for (const world of ["arena", "roam"]) {
      const option = node("option", "", `${VICTORIES[victory]} · ${WORLDS[world]}`);
      option.value = `${victory}:${world}`;
      select.append(option);
    }
    select.value = leaderboardSelection;
    select.onchange = () => { leaderboardSelection = select.value; paintLeaderboards(container, data); };
    label.append(select);
    const entry = data.boards[leaderboardSelection];
    const players = Array.isArray(entry) ? entry : entry?.players || [];
    const [victory, world] = leaderboardSelection.split(":");
    container.append(label, board(`${VICTORIES[victory]} · ${WORLDS[world]}`, players));
    // Compatibility aggregate includes old and new matches; never mix it into a ruleset board.
    if (data.players?.length) {
      const history = node("details");
      history.append(node("summary", "room-muted", "历史总榜（含旧版与全部玩法）"), board("兼容总榜", data.players));
      container.append(history);
    }
  }
  async function refreshLists(generation, roomsList, ranking) {
    if (generation !== epoch) return;
    try {
      const results = await Promise.allSettled([client.request("/rooms"), client.request("/leaderboard")]);
      if (generation !== epoch) return;
      roomsList.replaceChildren(); ranking.replaceChildren();
      if (results[0].status === "fulfilled") {
        const rooms = results[0].value.rooms || [];
        if (!rooms.length) roomsList.append(node("p", "room-muted", "还没有房间，开一局吧"));
        for (const room of rooms) {
          const row = node("div", "room-row");
          row.append(node("span", "", `${room.id} · ${modeLabel(room)} · ${STATUS[room.status] || room.status} · ${room.players.length} 条蛇${roomModes(room).victory === "score" ? " · " + countdown(room) : ""}`));
          row.append(button(room.status === "lobby" ? "加入 / 观看" : room.status === "finished" ? "结算 / 回放" : "实时观看", () => enter(room.id)));
          roomsList.append(row);
        }
      } else roomsList.append(node("p", "room-error", "暂时连不到房间服务，稍后自动重试；可在下方修改服务地址。"));
      if (results[1].status === "fulfilled") {
        paintLeaderboards(ranking, results[1].value);
      } else ranking.append(node("p", "room-muted", "排行榜暂时不可用"));
    } finally {
      schedule(() => refreshLists(generation, roomsList, ranking), 3000, generation);
    }
  }
  async function open(section = "live") {
    if (!["create", "live", "rank"].includes(section)) section = "live";
    stop();
    const generation = epoch;
    history.replaceState(null, "", location.pathname);
    onBrowse();
    directory.classList.remove("hidden");
    directory.replaceChildren();
    const shell = node("div", "room-shell");
    const header = node("div", "room-row"); header.append(node("h1", "", "联机房间"), button("单人菜单", () => { stop(); onMenu(); })); shell.append(header);
    const listCard = node("section", "room-card"); listCard.id = "room-live"; listCard.append(node("h2", "", "正在玩的房间"));
    const roomsList = node("div", "room-card", "正在读取……"); listCard.append(roomsList); shell.append(listCard);
    const joinForm = node("form", "room-row");
    const roomId = node("input"); roomId.placeholder = "房间编号"; roomId.setAttribute("aria-label", "房间编号"); roomId.required = true;
    const join = node("button", "btn", "打开房间"); join.type = "submit"; joinForm.append(roomId, join); joinForm.onsubmit = (e) => { e.preventDefault(); enter(roomId.value.trim()); }; shell.append(joinForm);
    const create = node("section"); create.id = "room-create"; create.append(node("p", "room-muted", "正在读取模型目录……")); shell.append(create);
    const rankings = node("section", "room-card"); rankings.id = "room-rank"; rankings.append(node("h2", "", "排行榜")); const ranking = node("div"); rankings.append(ranking); shell.append(rankings);
    const settings = node("form", "room-card");
    const label = node("label", "", "房间服务地址"); const base = node("input"); base.value = configuredBase; base.placeholder = "/api/ai-snake 或 http://localhost:端口"; base.setAttribute("aria-label", "房间服务地址"); label.append(base);
    const save = node("button", "btn", "连接此服务"); save.type = "submit"; settings.append(label, save);
    settings.onsubmit = (event) => { event.preventDefault(); try { const next = new RoomClient(base.value.trim()); client = next; configuredBase = base.value.trim(); localStorage.setItem("ai-snake-api", configuredBase); open(); } catch (err) { notice(err.message); } };
    shell.append(settings); directory.append(shell);
    refreshLists(generation, roomsList, ranking);
    try { const data = await client.request("/catalog"); catalogue = data.models || []; } catch { catalogue = []; }
    if (generation !== epoch) return;
    create.replaceChildren(); paintCreate(create);
    const target = { create, live: listCard, rank: rankings }[section];
    target.scrollIntoView({ block: "start" });
    const heading = target.querySelector("h2");
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }
  return { open, enter, stop, sendDirection, get active() { return !!current; } };
}
