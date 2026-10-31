// 皮肤码：一个皮肤就是一小段 JSON，人能捏，AI 也能照着图一格一格写。
// 分享时压成一串「SNK1.」开头的码，粘到哪儿都能还原。
import { PAL, SKIN_LOOK } from "./sprites.js?v=20261031e";

export const SKIN_FORMAT = "ai-snake-skin/1";
export const HEAD = 10;
export const NECK_W = 8;
export const NECK_H = 5;
export const MAX_COLORS = 16;
export const MAX_SAVED = 20;
const STORE = "ai-snake-skins";
const HEX = /^#[0-9a-fA-F]{6}$/;
const KEY = /^[A-Za-z0-9]$/;
const CODE_PREFIX = "SNK1.";

// 可编辑的示例：照着这个格式写就行
export const EXAMPLE = {
  format: SKIN_FORMAT,
  name: "小螃蟹",
  palette: { O: "#da7756", o: "#a9502f", E: "#1b1418", p: "#f2a285", n: "#f6a0ae" },
  head: [
    "..........",
    "..........",
    ".pOOOOOOo.",
    "pOOOOOOOOo",
    "OOEOOOOEOO",
    "OOEOOOOEOO",
    "nOOOOOOOOn",
    "OOOOOOOOOO",
    ".oooooooo.",
    "..........",
  ],
  happy: [
    "..........",
    "..........",
    ".pOOOOOOo.",
    "pOOOOOOOOo",
    "OOOOOOOOOO",
    "OEOEOOEOEO",
    "nOOOOOOOOn",
    "OOOOOOOOOO",
    ".oooooooo.",
    "..........",
  ],
  body: "#b9603d",
  edge: "#7f3a20",
  label: "#ffb38f",
  legs: true,
  hat: true,
};

function chars(s) { return Array.from(String(s)); }

function checkRows(rows, field, palette, { height, width, maxHeight }) {
  if (!Array.isArray(rows)) throw new Error(`${field} 要是一组字符串，一行一个`);
  if (height && rows.length !== height) throw new Error(`${field} 要正好 ${height} 行，现在是 ${rows.length} 行`);
  if (maxHeight && (rows.length < 1 || rows.length > maxHeight)) throw new Error(`${field} 要 1 到 ${maxHeight} 行`);
  return rows.map((row, j) => {
    if (typeof row !== "string") throw new Error(`${field} 第 ${j + 1} 行不是字符串`);
    let cs = chars(row);
    if (width && cs.length !== width) {
      if (maxHeight && cs.length < width) cs = cs.concat(Array(width - cs.length).fill("."));
      else throw new Error(`${field} 第 ${j + 1} 行要正好 ${width} 格，现在是 ${cs.length} 格`);
    }
    for (const c of cs) {
      if (c !== "." && !(c in palette)) throw new Error(`${field} 第 ${j + 1} 行用了调色板里没有的「${c}」`);
    }
    return cs.join("");
  });
}

function optColor(v, field) {
  if (v == null || v === "" || v === false) return undefined;
  if (!HEX.test(v)) throw new Error(`${field} 要写成 #rrggbb 这样的颜色`);
  return v.toLowerCase();
}

// 检查并整理一份皮肤；不对就抛出一句说得清哪儿错了的话
export function normalizeSkin(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("皮肤要是一个 JSON 对象");
  const palette = {};
  const entries = Object.entries(raw.palette || {});
  if (!entries.length) throw new Error("palette（调色板）至少要有一个颜色");
  if (entries.length > MAX_COLORS) throw new Error(`调色板最多 ${MAX_COLORS} 个颜色`);
  for (const [k, v] of entries) {
    if (!KEY.test(k)) throw new Error(`调色板的「${k}」不行：每个颜色用一个字母或数字当名字，「.」留给透明`);
    if (!HEX.test(v)) throw new Error(`调色板「${k}」要写成 #rrggbb 这样的颜色`);
    palette[k] = v.toLowerCase();
  }
  const head = checkRows(raw.head, "head", palette, { height: HEAD, width: HEAD });
  if (head.every((r) => /^\.*$/.test(r))) throw new Error("head 是空的，至少画一格");
  const happy = raw.happy == null ? undefined : checkRows(raw.happy, "happy", palette, { height: HEAD, width: HEAD });
  const neck = raw.neck == null ? undefined : checkRows(raw.neck, "neck", palette, { width: NECK_W, maxHeight: NECK_H });
  const first = Object.values(palette)[0];
  const body = optColor(raw.body, "body") || first;
  const name = chars(String(raw.name || "").replace(/[\u0000-\u001f<>]/g, "").trim()).slice(0, 8).join("") || "我的皮肤";
  const skin = { format: SKIN_FORMAT, name, palette, head };
  if (happy && happy.join() !== head.join()) skin.happy = happy;
  skin.body = body;
  skin.edge = optColor(raw.edge, "edge") || shade(body, -0.35);
  skin.label = optColor(raw.label, "label") || shade(body, 0.45);
  const tail = optColor(raw.tail, "tail");
  const dots = optColor(raw.dots, "dots");
  if (tail) skin.tail = tail;
  if (dots) skin.dots = dots;
  if (raw.legs === true) skin.legs = true;
  if (raw.hat === true) skin.hat = true;
  if (neck && !neck.every((r) => /^\.*$/.test(r))) skin.neck = neck;
  return skin;
}

export function checkSkin(raw) {
  try { return { ok: true, skin: normalizeSkin(raw) }; } catch (err) { return { ok: false, error: err.message }; }
}

// ---------- 皮肤码 ----------

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeSkin(skin) {
  return CODE_PREFIX + toBase64Url(JSON.stringify(normalizeSkin(skin)));
}

// 认三种：SNK1. 开头的码、带 ?skin= 的链接、直接贴的 JSON
export function decodeSkin(text) {
  let s = String(text || "").trim();
  const m = s.match(/[?&#]skin=([^&#\s]+)/);
  if (m) s = decodeURIComponent(m[1]);
  if (s.startsWith(CODE_PREFIX)) {
    let raw;
    try { raw = JSON.parse(fromBase64Url(s.slice(CODE_PREFIX.length).replace(/\s+/g, ""))); } catch { throw new Error("这串皮肤码不完整，可能复制的时候少了一截"); }
    return normalizeSkin(raw);
  }
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("没认出来：要么是 SNK1. 开头的皮肤码，要么是一段 JSON");
  let raw;
  try { raw = JSON.parse(s.slice(start, end + 1)); } catch (err) { throw new Error("JSON 没写对：" + err.message); }
  return normalizeSkin(raw);
}

// ---------- 皮肤 <-> 画的时候用的样子 ----------

export function lookFromSkin(skin) {
  return {
    name: skin.name, custom: true, pal: skin.palette,
    head: skin.head, happy: skin.happy || null,
    fill: skin.body, edge: skin.edge, label: skin.label,
    tail: skin.tail, dots: skin.dots, legs: !!skin.legs, hat: !!skin.hat, neck: skin.neck,
  };
}

// 把内置的皮肤导成皮肤码的格式，捏的时候可以从它改起
export function skinFromBuiltin(key) {
  const look = SKIN_LOOK[key];
  const happy = look.happy ? look.head.map((row, j) => look.happy[j] || row) : undefined;
  const used = new Set([...look.head, ...(happy || []), ...(look.neck || [])].join(""));
  used.delete(".");
  const palette = {};
  for (const c of used) palette[c] = PAL[c];
  return normalizeSkin({
    name: look.name, palette, head: look.head, happy, neck: look.neck,
    body: look.fill, edge: look.edge, label: look.label,
    tail: look.tail, dots: look.dots, legs: look.legs, hat: look.hat,
  });
}

export function blankSkin() {
  return normalizeSkin({
    name: "我的皮肤",
    palette: { a: "#f2a285", b: "#a9502f", c: "#1b1418" },
    head: [
      "..........", "..bbbbbb..", ".baaaaaab.", "baaaaaaaab", "bacaaaacab",
      "bacaaaacab", "baaaaaaaab", "baaaaaaaab", ".baaaaaab.", "..bbbbbb..",
    ],
    body: "#f2a285", edge: "#a9502f", label: "#ffd9c4",
  });
}

// ---------- 存在手机里的皮肤 ----------

export function loadSkins(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage.getItem(STORE) || "[]");
    return (Array.isArray(list) ? list : []).map(checkSkin).filter((r) => r.ok).map((r) => r.skin).slice(0, MAX_SAVED);
  } catch {
    return [];
  }
}

export function saveSkins(list, storage = globalThis.localStorage) {
  storage.setItem(STORE, JSON.stringify(list.slice(0, MAX_SAVED)));
}

// 收下一个皮肤：一模一样的不重复存，返回它在列表里的位置
export function addSkin(skin, storage = globalThis.localStorage) {
  const list = loadSkins(storage);
  const key = JSON.stringify(skin);
  let i = list.findIndex((s) => JSON.stringify(s) === key);
  if (i < 0) {
    if (list.length >= MAX_SAVED) throw new Error(`最多存 ${MAX_SAVED} 个皮肤，先删掉几个`);
    list.push(skin);
    i = list.length - 1;
    saveSkins(list, storage);
  }
  return i;
}

// ---------- 颜色 ----------

export function hexToRgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
export function rgbToHex(rgb) { return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); }
export function shade(hex, k) {
  const rgb = hexToRgb(hex);
  return rgbToHex(rgb.map((v) => (k < 0 ? v * (1 + k) : v + (255 - v) * k)));
}
function luma([r, g, b]) { return 0.299 * r + 0.587 * g + 0.114 * b; }
function dist2(a, b) {
  // 人眼对绿最敏感，按这个加权
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

// ---------- 找图里的主角 ----------
// img 是整张图缩小后的 RGBA。背景取出现最多的那个颜色；跟背景差得远的算主角，
// 横贯整行/整列的条（手机截图的状态栏、导航栏）不算，取最大的一块连着的区域框起来。
// 返回 { x, y, w, h, bg }，坐标在 img 自己的尺寸里。
export function findSubject(img) {
  const { data, width, height } = img;
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | (data[i + 2] >> 4);
    const b = bins.get(key) || [0, 0, 0, 0];
    b[0] += data[i]; b[1] += data[i + 1]; b[2] += data[i + 2]; b[3]++;
    bins.set(key, b);
  }
  let top = null;
  for (const b of bins.values()) if (!top || b[3] > top[3]) top = b;
  const whole = { x: 0, y: 0, w: width, h: height, bg: null };
  if (!top) return whole;
  const bg = [top[0] / top[3], top[1] / top[3], top[2] / top[3]];
  whole.bg = bg;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    mask[p] = data[i + 3] >= 128 && dist2([data[i], data[i + 1], data[i + 2]], bg) > 9 * 30 * 30 ? 1 : 0;
  }
  // 只削贴着图边的整条：主角自己把画面撑满时，中间的行不能被当成状态栏削掉
  const rowFull = (y) => { let n = 0; for (let x = 0; x < width; x++) n += mask[y * width + x]; return n > width * 0.8; };
  const colFull = (x) => { let n = 0; for (let y = 0; y < height; y++) n += mask[y * width + x]; return n > height * 0.8; };
  const clearRow = (y) => { for (let x = 0; x < width; x++) mask[y * width + x] = 0; };
  const clearCol = (x) => { for (let y = 0; y < height; y++) mask[y * width + x] = 0; };
  for (let y = 0; y < height && rowFull(y); y++) clearRow(y);
  for (let y = height - 1; y >= 0 && rowFull(y); y--) clearRow(y);
  for (let x = 0; x < width && colFull(x); x++) clearCol(x);
  for (let x = width - 1; x >= 0 && colFull(x); x--) clearCol(x);
  const label = new Int32Array(width * height).fill(-1);
  let best = null;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const box = { x0: width, y0: height, x1: 0, y1: 0, n: 0 };
    const stack = [s];
    label[s] = s;
    while (stack.length) {
      const p = stack.pop();
      const x = p % width, y = (p - x) / width;
      box.n++;
      if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q >= 0 && mask[q] && label[q] < 0) { label[q] = s; stack.push(q); }
      }
    }
    if (!best || box.n > best.n) best = box;
  }
  if (!best || best.n < width * height * 0.01) return whole;
  return { x: best.x0, y: best.y0, w: best.x1 - best.x0 + 1, h: best.y1 - best.y0 + 1, bg };
}

// ---------- 图片变像素头像 ----------
// img = { data, width, height }（RGBA），已经裁好、缩到 cells 的整数倍。
// bg 给了就按它去背景（整张图里出现最多的颜色），没给就看边上一圈。
// 返回一份皮肤；只是底稿，想好看还得在格子上手调。
export function pixelize(img, { cells = HEAD, colors = 6, removeBg = true, outline = true, name, bg: knownBg } = {}) {
  const { data, width, height } = img;
  const bw = width / cells, bh = height / cells;
  const grid = []; // 每格 [r,g,b] 或 null（透明）
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = Math.floor(y * bh); yy < Math.floor((y + 1) * bh); yy++) {
        for (let xx = Math.floor(x * bw); xx < Math.floor((x + 1) * bw); xx++) {
          const i = (yy * width + xx) * 4, al = data[i + 3] / 255;
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; n++;
        }
      }
      grid.push(a / n < 0.5 ? null : [r / a, g / a, b / a]);
    }
  }
  if (removeBg) {
    // 背景色从边上往里淹，跟背景像、又跟边连着的格子才变透明；主角身上同色的地方被描边隔开就留着
    const border = [];
    for (let i = 0; i < cells; i++) for (const j of [i, cells * (cells - 1) + i, i * cells, i * cells + cells - 1]) if (grid[j]) border.push(grid[j]);
    const bg = knownBg || (border.length >= 4
      ? [0, 1, 2].map((k) => border.map((c) => c[k]).sort((p, q) => p - q)[Math.floor(border.length / 2)])
      : null);
    if (bg) {
      // 已经透明的格子（图外面补的空）也让水流过去
      const near = (i) => !grid[i] || dist2(grid[i], bg) < 9 * 26 * 26;
      const seen = new Set();
      const stack = [];
      for (let i = 0; i < cells; i++) for (const j of [i, cells * (cells - 1) + i, i * cells, i * cells + cells - 1]) if (near(j)) stack.push(j);
      while (stack.length) {
        const i = stack.pop();
        if (seen.has(i)) continue;
        seen.add(i);
        const x = i % cells, y = Math.floor(i / cells);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, j = ny * cells + nx;
          if (nx >= 0 && ny >= 0 && nx < cells && ny < cells && !seen.has(j) && near(j)) stack.push(j);
        }
      }
      for (const i of seen) grid[i] = null;
    }
  }
  const solid = grid.filter(Boolean);
  if (!solid.length) throw new Error("这张图去掉背景以后什么都没剩下，试试关掉「去背景」");
  // 颜色压到 colors 种：最远点起头，再 k-means 几轮
  const k = Math.max(1, Math.min(colors, MAX_COLORS - 1, solid.length));
  const mean = [0, 1, 2].map((c) => solid.reduce((s, p) => s + p[c], 0) / solid.length);
  const centers = [solid.reduce((best, p) => (dist2(p, mean) < dist2(best, mean) ? p : best))];
  while (centers.length < k) {
    let far = null, fd = -1;
    for (const p of solid) {
      const d = Math.min(...centers.map((c) => dist2(p, c)));
      if (d > fd) { fd = d; far = p; }
    }
    if (fd <= 0) break;
    centers.push(far);
  }
  let assign = [];
  for (let round = 0; round < 12; round++) {
    assign = grid.map((p) => (p ? centers.reduce((bi, c, ci) => (dist2(p, c) < dist2(p, centers[bi]) ? ci : bi), 0) : -1));
    const sums = centers.map(() => [0, 0, 0, 0]);
    grid.forEach((p, i) => { if (p) { const s = sums[assign[i]]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; } });
    sums.forEach((s, ci) => { if (s[3]) centers[ci] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const counts = centers.map((_, ci) => assign.filter((a) => a === ci).length);
  const keys = "abcdefghijklmnop";
  const palette = {};
  centers.forEach((c, ci) => { if (counts[ci]) palette[keys[ci]] = rgbToHex(c); });
  const cellKey = assign.map((a) => (a < 0 ? "." : keys[a]));
  const main = counts.indexOf(Math.max(...counts));
  let edgeKey = null;
  if (outline) {
    // 跟透明挨着的那一圈换成深一档的描边色，跟别的皮肤一个画法
    edgeKey = keys[centers.length];
    palette[edgeKey] = shade(rgbToHex(centers[main]), -0.55);
    const ring = [];
    for (let i = 0; i < cellKey.length; i++) {
      if (cellKey[i] === ".") continue;
      const x = i % cells, y = Math.floor(i / cells);
      const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx < 0 || ny < 0 || nx >= cells || ny >= cells || cellKey[ny * cells + nx] === ".";
      });
      if (open) ring.push(i);
    }
    // 整张图都是实心的（没有透明）就不描了，不然只剩一圈框
    if (ring.length < cellKey.filter((c) => c !== ".").length) for (const i of ring) cellKey[i] = edgeKey;
  }
  const used = new Set(cellKey);
  for (const key of Object.keys(palette)) if (!used.has(key)) delete palette[key];
  const head = [];
  for (let y = 0; y < cells; y++) head.push(cellKey.slice(y * cells, (y + 1) * cells).join(""));
  const body = rgbToHex(centers[main]);
  const lightest = Object.values(palette).map(hexToRgb).sort((a, b) => luma(b) - luma(a))[0];
  return normalizeSkin({
    name: name || "我的皮肤", palette, head,
    body, edge: palette[edgeKey] || shade(body, -0.45),
    label: luma(lightest) > 150 ? rgbToHex(lightest) : shade(body, 0.5),
  });
}
