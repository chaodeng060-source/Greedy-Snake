#!/usr/bin/env node
// 命令行入口：AI 用它开局、看棋盘、出手。每一步都写回局面文件，网页那边轮询这个文件就能实时看。
//
//   node cli.mjs new  [--file g.json] [--size 15] [--seed 7] [--players crab] [--wrap]（--wrap 能穿墙）
//   node cli.mjs look [--file g.json] [--as crab]
//   node cli.mjs move RRUU [--file g.json] [--as crab] [--say "绕过去"]
//
// 单人局里 move 会连走这一串，吃到糖或出局就停下，剩下的不走（糖换了位置，要重新看）。
// 多人局里 move 只登记你这一回合的方向，等所有活着的蛇都出了手才一起走一步。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { baseURL, requestJSON, SafeError } from "./bots/http.mjs";
import { newGame, replay, step, renderText, parseMoves } from "../../web/public/ai-snake/engine.js";

export function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

function offline(a) {
  const cmd = a._[0];
  const file = path.resolve(a.file || process.env.SNAKE_GAME || "games/current.json");

  function load() {
    if (!fs.existsSync(file)) throw new Error(`没有这一局：${file}，先 new`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  function save(game) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(game));
    fs.renameSync(tmp, file);
  }

  function asId(game) {
    const id = a.as || game.config.players[0].id;
    if (!game.config.players.some((p) => p.id === id)) throw new Error(`这一局里没有 ${id}`);
    return id;
  }

  if (cmd === "new") {
    const size = Number(a.size || 15);
    const players = String(a.players || "crab").split(",").map((s) => ({ id: s.trim(), skin: s.trim() }));
    const game = newGame({ width: size, height: size, seed: a.seed != null ? Number(a.seed) : undefined, players, wrap: Boolean(a.wrap) });
    game.pending = {};
    save(game);
    console.log(`开局了：${file}\n`);
    console.log(renderText(replay(game), game.config, asId(game)));
  } else if (cmd === "look") {
    const game = load();
    console.log(renderText(replay(game), game.config, asId(game)));
  } else if (cmd === "move") {
    const game = load();
    const me = asId(game);
    const plan = parseMoves(a._.slice(1).join(""));
    if (!plan.length) throw new Error("没认出方向，用 U/D/L/R");
    let state = replay(game);
    const multi = game.config.players.length > 1;
    const notes = [];
    if (multi) {
      game.pending = game.pending || {};
      game.pending[me] = plan[0];
      if (a.say) game.pendingSay = { ...(game.pendingSay || {}), [me]: String(a.say) };
      const waiting = state.snakes.filter((s) => s.alive && !game.pending[s.id]).map((s) => s.name);
      if (waiting.length) {
        notes.push(`登记了 ${plan[0]}，在等 ${waiting.join("、")} 出手`);
      } else {
        const idx = game.moves.length;
        game.moves.push({ ...game.pending });
        if (game.pendingSay) game.says[idx] = game.pendingSay;
        game.pending = {};
        game.pendingSay = undefined;
        state = step(state, game.config, game.moves[idx]);
        for (const e of state.events) notes.push(describe(e, state));
      }
    } else {
      let walked = 0;
      for (const d of plan) {
        if (state.over) break;
        const idx = game.moves.length;
        game.moves.push({ [me]: d });
        if (a.say && walked === 0) game.says[idx] = { [me]: String(a.say) };
        state = step(state, game.config, game.moves[idx]);
        walked++;
        const stop = state.events.find((e) => e.type === "eat" || e.type === "die");
        for (const e of state.events) notes.push(describe(e, state));
        if (stop) break;
      }
      if (walked < plan.length && !state.over) notes.push(`吃到糖停下了，走了 ${walked} 步，剩下 ${plan.length - walked} 步没走`);
    }
    save(game);
    if (notes.length) console.log(notes.join("\n") + "\n");
    console.log(renderText(state, game.config, me));
  } else if (cmd === "end") {
    // 不想玩了就收手：这一局停在当前回合，网页那边看到这一步就放结局
    const game = load();
    const state = replay(game);
    game.ended = { turn: state.turn, by: asId(game), reason: String(a.say || "收手了") };
    save(game);
    console.log(`收手了，停在第 ${state.turn} 回合`);
  } else {
    console.log("用法：new | look | move <方向串> | end，参数见文件开头注释");
    if (cmd) throw new Error("未知离线命令");
  }
}

function describe(e, state) {
  const name = (id) => (state.snakes.find((s) => s.id === id) || {}).name || id;
  if (e.type === "eat") return `${name(e.id)} 吃到一颗南瓜糖`;
  if (e.type === "die") return `${name(e.id)} 出局：${e.reason}`;
  if (e.type === "over") return e.winner ? `结束，${name(e.winner)} 赢了` : "结束";
  return "";
}

function readSession(file) {
  if (!file || !fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new SafeError("session 文件不是有效 JSON", "CONFIG"); }
}

function saveSession(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function publicResult(value) {
  if (Array.isArray(value)) return value.map(publicResult);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:token|hostToken|apiKey|authorization|tokenHash|hostHash)$/i.test(key))
    .map(([key, item]) => [key, publicResult(item)]));
  return value;
}

/** Online commands use --url; without it the original file-based commands still work. */
export async function runCLI(argv = process.argv.slice(2), {env = process.env, fetchImpl, output = console.log} = {}) {
  const a = args(argv), command = a._[0]?.replace(/^room-/, "");
  const online = a.url || a.session || a._[0]?.startsWith("room-") || ["join", "plan", "start", "wait", "replay", "leaderboard", "rooms", "catalog", "settlement"].includes(command);
  if (!online) { offline(a); return; }
  if (a.session === true || a.url === true) throw new SafeError("--session 和 --url 需要参数", "CONFIG");
  const sessionFile = a.session ? path.resolve(a.session) : undefined;
  const session = readSession(sessionFile);
  const url = baseURL(a.url || session.url);
  if (session.url && baseURL(session.url) !== url) throw new SafeError("session 属于另一个服务地址", "CONFIG");
  const room = a.room || (command === "plan" ? (a._.length > 2 ? a._[1] : undefined) : a._[1]) || session.roomId;
  if (room && session.roomId && room !== session.roomId) throw new SafeError("session 属于另一个房间", "CONFIG");
  const playerId = a.as || a.player || session.playerId;
  const request = (route, body, headers, timeoutMs) => requestJSON(`${url}${route}`, {body, fetchImpl, headers, ...(timeoutMs ? {timeoutMs} : {})});
  const seatToken = env.AI_SNAKE_PLAYER_TOKEN || session.token;
  const seatHeaders = seatToken ? {"X-Seat-Token": seatToken} : {};
  const roomPath = `/rooms/${encodeURIComponent(room)}`;
  let result;
  if (command === "create") {
    let body;
    try {
      if (a.config && a.config !== true) body = JSON.parse(fs.readFileSync(path.resolve(a.config), "utf8"));
      else if (a.json && a.json !== true) body = JSON.parse(a.json);
      else throw new Error();
    } catch { throw new SafeError("room-create 需要 --config JSON文件 或 --json JSON对象", "CONFIG"); }
    result = await request("/rooms", body);
  } else if (["leaderboard", "rooms", "catalog"].includes(command)) result = await request(`/${command}`);
  else {
    if (!room || room === true) throw new SafeError("需要 --room ID、位置参数或 --session", "CONFIG");
    if (command === "join") {
      result = await request(`${roomPath}/join`, {kind: a.kind || "ai", ...(a.name ? {name: a.name} : {}), ...(playerId ? {playerId} : {})});
    } else if (command === "look") {
      if (!playerId) throw new SafeError("look 需要 --as PLAYER 或 session 的座位", "CONFIG");
      result = await request(`${roomPath}/look?as=${encodeURIComponent(playerId)}`, undefined, seatHeaders);
    } else if (command === "wait") {
      if (!playerId) throw new SafeError("wait 需要 --as PLAYER 或 session 的座位", "CONFIG");
      const after = a.after && a.after !== true ? `&after=${encodeURIComponent(a.after)}` : "";
      result = await request(`${roomPath}/wait?as=${encodeURIComponent(playerId)}${after}`, undefined, seatHeaders, 60000);
    } else if (command === "plan") {
      const token = env.AI_SNAKE_PLAYER_TOKEN || session.token;
      if (!playerId || !token) throw new SafeError("plan 需要座位和 session 或 AI_SNAKE_PLAYER_TOKEN", "CONFIG");
      const moves = a.moves || (a._.length > 2 ? a._.slice(2) : a._.slice(1)).join("");
      if (!/^[UDLR]+$/.test(moves || "")) throw new SafeError("plan 方向须为大写 UDLR", "CONFIG");
      result = await request(`${roomPath}/plan`, {playerId, token, moves, requestId: a["request-id"] || randomUUID()});
    } else if (command === "start") {
      const hostToken = env.AI_SNAKE_HOST_TOKEN || session.hostToken;
      if (!hostToken) throw new SafeError("start 需要房主 session 或 AI_SNAKE_HOST_TOKEN", "CONFIG");
      result = await request(`${roomPath}/start`, {hostToken, ...(a["drop-empty"] ? {dropEmpty: true} : {})});
    } else if (["replay", "settlement"].includes(command)) result = await request(`${roomPath}/${command}`);
    else throw new SafeError("房间命令：room-create | join | look | wait | plan | start [--drop-empty] | replay | leaderboard | rooms | catalog | settlement", "CONFIG");
  }
  if (result.token || result.hostToken) {
    if (sessionFile) saveSession(sessionFile, {...(command === "create" ? {} : session), url, roomId: result.room.id,
      ...(result.playerId ? {playerId: result.playerId} : {}),
      ...(result.token ? {token: result.token} : {}), ...(result.hostToken ? {hostToken: result.hostToken} : {})});
    else output("凭据未保存；下次 create/join 加 --session 本地文件，凭据不会显示在终端。");
  }
  const visible = publicResult(result);
  if (a.out && a.out !== true) fs.writeFileSync(path.resolve(a.out), JSON.stringify(visible, null, 2));
  else output(JSON.stringify(visible, null, 2));
  return visible;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCLI().catch(error => {
    console.error(error instanceof SafeError ? error.message : "命令失败，请检查文件与参数");
    process.exitCode = 1;
  });
}
