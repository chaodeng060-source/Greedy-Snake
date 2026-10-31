// 捏皮肤：从现成的皮肤或一张图起头，在 10×10 的格子上一格一格改，存成皮肤码。
import { PAL, PUMPKIN, drawSprite } from "./sprites.js?v=20261031d";
import { drawSnake, headIcon, CELL } from "./draw.js?v=20261031d";
import {
  HEAD, NECK_W, NECK_H, MAX_COLORS, EXAMPLE,
  normalizeSkin, encodeSkin, decodeSkin, skinFromBuiltin, blankSkin,
  loadSkins, saveSkins, addSkin, pixelize, findSubject, shade, hexToRgb,
} from "./skin.js?v=20261031d";

const $ = (s) => document.querySelector(s);
const KEYS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// ---------- 正在捏的这一个 ----------

let work = null;      // { name, palette, head, happy, neck, body, edge, label, tail, dots, legs, hat, autoBody }，格子是二维字符数组
let editing = -1;     // 从「我的皮肤」里点「改」进来的，存的时候覆盖那一个
let layer = "head";
let tool = "pen";
let sel = ".";
let look = null;      // 预览用，改一下重算一次

const toGrid = (rows, w, h) => Array.from({ length: h }, (_, j) => Array.from({ length: w }, (_, i) => (rows && rows[j] ? Array.from(rows[j])[i] || "." : ".")));
const toRows = (grid) => grid.map((r) => r.join(""));
const blankGrid = (w, h) => toGrid(null, w, h);
const isBlank = (grid) => grid.every((r) => r.every((c) => c === "."));

// 「空白」：格子一格都没画，调色板先放几个常用色，自己挑着染；身子颜色跟着头上用得最多的颜色走
const STARTER = { a: "#1b1418", b: "#ffffff", c: "#f2a285", d: "#da7756", e: "#f6a0ae", f: "#8f776b", g: "#9aa3c7", h: "#ffd23f" };
function emptySkin() {
  const body = "#9aa3c7";
  return {
    name: "我的皮肤", palette: { ...STARTER }, head: Array(HEAD).fill(".".repeat(HEAD)),
    body, edge: shade(body, -0.35), label: shade(body, 0.45), autoBody: true,
  };
}

function load(skin, index = -1) {
  editing = index;
  work = {
    name: skin.name,
    palette: { ...skin.palette },
    head: toGrid(skin.head, HEAD, HEAD),
    happy: skin.happy ? toGrid(skin.happy, HEAD, HEAD) : null,
    neck: skin.neck ? toGrid(skin.neck, NECK_W, NECK_H) : null,
    body: skin.body, edge: skin.edge, label: skin.label,
    tail: skin.tail || null, dots: skin.dots || null, legs: !!skin.legs, hat: !!skin.hat,
    autoBody: !!skin.autoBody,
  };
  sel = Object.keys(work.palette)[0] || ".";
  $("#name").value = work.name;
  setLayer(layer === "happy" && !work.happy ? "head" : layer);
  paintSide();
  changed();
}

// ---------- 撤销 / 重做：格子、调色板、身子颜色、配件、名字、换起头，全都退得回去 ----------

let undo = [];
let redo = [];
let burst = null; // 拖颜色、拖滑条这种连着改的，一整下只记一步

function snap() {
  return JSON.stringify({ editing, work });
}
function record() {
  if (!work) return;
  undo.push(snap());
  if (undo.length > 100) undo.shift();
  redo = [];
  burst = null;
}
function beginBurst(key) {
  if (burst !== key) { record(); burst = key; }
}
function endBurst() { burst = null; }
function restore(text) {
  const s = JSON.parse(text);
  editing = s.editing;
  work = s.work;
  $("#name").value = work.name;
  if (!(sel in work.palette)) sel = Object.keys(work.palette)[0] || ".";
  setLayer(layer === "happy" && !work.happy ? "head" : layer);
  paintSide();
  changed();
}
function paintUndo() {
  $("#undo").disabled = !undo.length;
  $("#redo").disabled = !redo.length;
}

function current() {
  if (layer === "happy") {
    if (!work.happy) work.happy = work.head.map((r) => r.slice());
    return work.happy;
  }
  if (layer === "neck") {
    if (!work.neck) work.neck = blankGrid(NECK_W, NECK_H);
    return work.neck;
  }
  return work.head;
}

// 拼回一份皮肤；用不到的颜色顺手删掉
function build() {
  if (isBlank(work.head)) throw new Error("头还是空的，先在「平时」那层画几格");
  const used = new Set([work.head, work.happy, work.neck].filter(Boolean).flatMap((g) => g.flat()));
  const palette = {};
  for (const [k, v] of Object.entries(work.palette)) if (used.has(k)) palette[k] = v;
  return normalizeSkin({
    name: $("#name").value.trim() || "我的皮肤",
    palette,
    head: toRows(work.head),
    happy: work.happy ? toRows(work.happy) : undefined,
    neck: work.neck && !isBlank(work.neck) ? toRows(work.neck) : undefined,
    body: work.body, edge: work.edge, label: work.label,
    tail: work.tail || undefined, dots: work.dots || undefined, legs: work.legs, hat: work.hat,
  });
}

let statusTimer = 0;
function status(text, err = false) {
  const el = $("#status");
  el.textContent = text;
  el.classList.toggle("err", err);
  clearTimeout(statusTimer);
  // 出错的那句多留一会儿，点一下就收
  statusTimer = setTimeout(() => { el.textContent = ""; }, err ? 12000 : 4000);
}
$("#status").onclick = () => status("");
// 页面里不管哪儿出了错，都在屏幕上说出来，别一声不响
addEventListener("error", (e) => status("出错了：" + (e.message || "未知错误"), true));
addEventListener("unhandledrejection", (e) => status("出错了：" + ((e.reason && e.reason.message) || e.reason || "未知错误"), true));

// 预览直接拿正在捏的画，头还空着也能看到身子；格式检查留到存和分享的时候
function lookFromWork() {
  return {
    name: work.name, custom: true, pal: work.palette,
    head: toRows(work.head), happy: work.happy ? toRows(work.happy) : null,
    fill: work.body, edge: work.edge, label: work.label,
    tail: work.tail || undefined, dots: work.dots || undefined, legs: work.legs, hat: work.hat,
    neck: work.neck && !isBlank(work.neck) ? toRows(work.neck) : undefined,
  };
}

// 从空白起的，身子颜色跟着头上用得最多的颜色走（太黑的描边色不算），自己调过身子就不再跟
function followBody() {
  const count = {};
  for (const c of work.head.flat()) if (c !== "." && work.palette[c]) count[c] = (count[c] || 0) + 1;
  const keys = Object.keys(count);
  if (!keys.length) return;
  const luma = (hex) => { const [r, g, b] = hexToRgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b; };
  const bright = keys.filter((k) => luma(work.palette[k]) > 60);
  const pool = bright.length ? bright : keys;
  const body = work.palette[pool.reduce((a, b) => (count[b] > count[a] ? b : a))];
  if (body === work.body) return;
  work.body = body;
  work.edge = shade(body, -0.35);
  work.label = shade(body, 0.45);
  paintSide();
}

function changed() {
  if (work.autoBody) followBody();
  look = lookFromWork();
  paintGrid();
  paintPalette();
  paintUndo();
}

// ---------- 格子 ----------

const grid = $("#grid");
const gctx = grid.getContext("2d");
const PX = 34; // 画布上一格多大，CSS 再缩放到屏幕宽

function paintGrid() {
  const g = current();
  const w = g[0].length, h = g.length;
  if (grid.width !== w * PX || grid.height !== h * PX) { grid.width = w * PX; grid.height = h * PX; }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = g[y][x];
      if (c === ".") {
        gctx.fillStyle = (x + y) % 2 ? "#20254d" : "#2a2f5c";
        gctx.fillRect(x * PX, y * PX, PX, PX);
        // 「吃到糖时」那一层，把平时的样子淡淡垫在底下，好对着改
        if (layer === "happy" && work.head[y][x] !== ".") {
          gctx.globalAlpha = 0.25;
          gctx.fillStyle = work.palette[work.head[y][x]] || "#888";
          gctx.fillRect(x * PX, y * PX, PX, PX);
          gctx.globalAlpha = 1;
        }
      } else {
        gctx.fillStyle = work.palette[c] || "#f0f";
        gctx.fillRect(x * PX, y * PX, PX, PX);
      }
    }
  }
  gctx.strokeStyle = "rgba(255,255,255,.08)";
  gctx.lineWidth = 1;
  for (let i = 1; i < w; i++) { gctx.beginPath(); gctx.moveTo(i * PX + 0.5, 0); gctx.lineTo(i * PX + 0.5, h * PX); gctx.stroke(); }
  for (let j = 1; j < h; j++) { gctx.beginPath(); gctx.moveTo(0, j * PX + 0.5); gctx.lineTo(w * PX, j * PX + 0.5); gctx.stroke(); }
}

function cellAt(e) {
  const r = grid.getBoundingClientRect();
  const g = current();
  const x = Math.floor(((e.clientX - r.left) / r.width) * g[0].length);
  const y = Math.floor(((e.clientY - r.top) / r.height) * g.length);
  return x >= 0 && y >= 0 && x < g[0].length && y < g.length ? [x, y] : null;
}

function flood(g, x, y, to) {
  const from = g[y][x];
  if (from === to) return;
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cy < 0 || cx < 0 || cy >= g.length || cx >= g[0].length || g[cy][cx] !== from) continue;
    g[cy][cx] = to;
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

let drawing = false;
grid.addEventListener("pointerdown", (e) => {
  const at = cellAt(e);
  if (!at) return;
  e.preventDefault();
  const g = current();
  const [x, y] = at;
  if (tool === "pick") {
    sel = g[y][x];
    setTool("pen");
    paintPalette();
    return;
  }
  if (tool === "fill") {
    if (g[y][x] !== sel) { record(); flood(g, x, y, sel); changed(); }
    return;
  }
  drawing = true;
  stroked = false;
  try { grid.setPointerCapture(e.pointerId); } catch {}
  paintCell(x, y);
});
// 一笔划下去只记一步撤销；点在同色的格子上不算改
let stroked = false;
function paintCell(x, y) {
  const g = current();
  if (g[y][x] === sel) return;
  if (!stroked) { record(); stroked = true; }
  g[y][x] = sel;
  changed();
}
grid.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const at = cellAt(e);
  if (at) paintCell(at[0], at[1]);
});
for (const ev of ["pointerup", "pointercancel"]) grid.addEventListener(ev, () => { drawing = false; });

function setLayer(name) {
  layer = name;
  for (const b of document.querySelectorAll("[data-layer]")) b.classList.toggle("on", b.dataset.layer === name);
  $("#layer-hint").textContent = {
    head: "点一下颜色选它，选中的再点一下就能换颜色。",
    happy: "吃到糖那一下换成这张脸。底下淡淡的是平时的样子，改眼睛嘴巴就行。",
    neck: "系在下巴底下的东西，比如领带、围巾、铃铛。空着就是什么都不系。",
  }[name];
  paintGrid();
}
for (const b of document.querySelectorAll("[data-layer]")) b.onclick = () => { setLayer(b.dataset.layer); changed(); };

function setTool(name) {
  tool = name;
  for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("on", b.dataset.tool === name);
}
for (const b of document.querySelectorAll("[data-tool]")) b.onclick = () => setTool(b.dataset.tool);

$("#undo").onclick = () => {
  const last = undo.pop();
  if (!last) return status("没有可以撤销的了");
  redo.push(snap());
  burst = null;
  restore(last);
};
$("#redo").onclick = () => {
  const next = redo.pop();
  if (!next) return status("没有可以重做的了");
  undo.push(snap());
  burst = null;
  restore(next);
};

// ---------- 调色板 ----------

const picker = $("#picker");
let pickerKey = null;

function paintPalette() {
  const box = $("#palette");
  box.innerHTML = "";
  const clear = document.createElement("button");
  clear.className = "swatch clear" + (sel === "." ? " sel" : "");
  clear.title = "透明";
  clear.onclick = () => { sel = "."; setTool(tool === "pick" ? "pen" : tool); paintPalette(); };
  box.append(clear);
  for (const [k, v] of Object.entries(work.palette)) {
    const b = document.createElement("button");
    b.className = "swatch" + (sel === k ? " sel" : "");
    b.style.background = v;
    b.onclick = () => {
      if (sel === k) openPicker(k);
      else { sel = k; if (tool === "pick") setTool("pen"); paintPalette(); }
    };
    box.append(b);
  }
  if (Object.keys(work.palette).length < MAX_COLORS) {
    const add = document.createElement("button");
    add.className = "swatch add";
    add.textContent = "+";
    add.title = "加一个颜色";
    add.onclick = () => {
      const k = Array.from(KEYS).find((c) => !(c in work.palette));
      record();
      burst = "picker:" + k; // 加色和接着挑这个色算同一步
      work.palette[k] = sel !== "." ? work.palette[sel] : "#ffffff";
      sel = k;
      changed();
      openPicker(k);
    };
    box.append(add);
  }
}

function openPicker(k) {
  pickerKey = k;
  picker.value = work.palette[k];
  picker.click();
}
picker.addEventListener("input", () => {
  if (!pickerKey || work.palette[pickerKey] === picker.value) return;
  beginBurst("picker:" + pickerKey);
  work.palette[pickerKey] = picker.value;
  changed();
});
picker.addEventListener("change", endBurst);

// ---------- 身子和配件 ----------

function paintSide() {
  $("#c-body").value = work.body;
  $("#c-edge").value = work.edge;
  $("#c-label").value = work.label;
  $("#x-tail").checked = !!work.tail;
  if (work.tail) $("#c-tail").value = work.tail;
  $("#x-dots").checked = !!work.dots;
  if (work.dots) $("#c-dots").value = work.dots;
  $("#x-legs").checked = work.legs;
  $("#x-hat").checked = work.hat;
}
function readSide() {
  work.body = $("#c-body").value;
  work.edge = $("#c-edge").value;
  work.label = $("#c-label").value;
  work.tail = $("#x-tail").checked ? $("#c-tail").value : null;
  work.dots = $("#x-dots").checked ? $("#c-dots").value : null;
  work.legs = $("#x-legs").checked;
  work.hat = $("#x-hat").checked;
  changed();
}
for (const id of ["c-body", "c-edge", "c-label", "c-tail", "c-dots"]) {
  const el = $("#" + id);
  el.addEventListener("input", () => {
    beginBurst(id);
    // 自己动过身子的颜色，就不再跟着头走
    if (id === "c-body" || id === "c-edge" || id === "c-label") work.autoBody = false;
    readSide();
  });
  el.addEventListener("change", endBurst);
}
for (const id of ["x-tail", "x-dots", "x-legs", "x-hat"]) $("#" + id).addEventListener("change", () => { record(); readSide(); });
$("#name").addEventListener("input", () => { beginBurst("name"); work.name = $("#name").value; paintUndo(); });
$("#name").addEventListener("change", endBurst);

// ---------- 起头：现成的、空白、图片 ----------

function startFrom(t) {
  if (t === "empty") return emptySkin();
  if (t === "blank") return blankSkin();
  const skin = skinFromBuiltin(t);
  return { ...skin, name: "我的" + skin.name };
}
for (const b of document.querySelectorAll("[data-tpl]")) {
  b.onclick = () => {
    const t = b.dataset.tpl;
    record();
    load(startFrom(t));
    $("#photo").classList.add("hidden");
    status(t === "empty" ? "空白的，挑个颜色在格子上画；点错了按撤销" : `从「${b.textContent}」改起，点错了按撤销`);
  };
}

// 先用 blob 地址读，读不出来再按 data 地址读一遍；有的手机浏览器只认其中一种
function loadImage(src) {
  return new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => bad(new Error("decode"));
    img.src = src;
  });
}
function readAsDataURL(file) {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => bad(r.error || new Error("read"));
    r.readAsDataURL(file);
  });
}
async function readPhoto(file) {
  const url = URL.createObjectURL(file);
  let img;
  try { img = await loadImage(url); }
  catch { img = await loadImage(await readAsDataURL(file)); }
  finally { URL.revokeObjectURL(url); }
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error("decode");
  // 大照片先缩到 1200 以内放进画布，手机上拖滑条才不卡
  const k = Math.min(1, 1200 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

let photo = null; // 缩好的图，一块画布
$("#pick-photo").onclick = () => $("#file").click();
$("#file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  status("正在读图……");
  try {
    photo = await readPhoto(file);
  } catch {
    const kind = /hei[cf]/i.test(file.type + file.name) ? "HEIC 格式的照片浏览器读不了，截个图再传" : "这张图打不开，换一张或者截个图再传";
    status(kind + (file.type ? `（${file.type}）` : ""), true);
    return;
  } finally {
    e.target.value = "";
  }
  $("#photo").classList.remove("hidden");
  for (const id of ["zoom", "offx", "offy"]) $("#" + id).value = id === "zoom" ? 100 : 0;
  record();
  if (fromPhoto(true)) $("#photo").scrollIntoView({ behavior: "smooth", block: "start" });
});

// 一张图进来先找主角：框住它取一块正方形，放大就框得更小，左右上下在主角身上挪
let subject = null; // { cx, cy, side, bg }，原图坐标

function findPhotoSubject() {
  const w = photo.width, h = photo.height;
  const k = Math.min(1, 160 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(photo, 0, 0, c.width, c.height);
  const s = findSubject(x.getImageData(0, 0, c.width, c.height));
  subject = { cx: (s.x + s.w / 2) / k, cy: (s.y + s.h / 2) / k, side: (Math.max(s.w, s.h) / k) * 1.08, bg: s.bg };
}

function cropRect() {
  const side = subject.side / (Number($("#zoom").value) / 100);
  const ox = Number($("#offx").value) / 100, oy = Number($("#offy").value) / 100;
  const cx = subject.cx + (ox * subject.side) / 2, cy = subject.cy + (oy * subject.side) / 2;
  return [cx - side / 2, cy - side / 2, side];
}

// 框出了图外面的部分留成透明，不拉伸
function drawCrop(ctx, size, [sx, sy, side]) {
  const w = photo.width, h = photo.height, k = size / side;
  const x0 = Math.max(0, sx), y0 = Math.max(0, sy), x1 = Math.min(w, sx + side), y1 = Math.min(h, sy + side);
  ctx.clearRect(0, 0, size, size);
  if (x1 > x0 && y1 > y0) ctx.drawImage(photo, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * k, (y0 - sy) * k, (x1 - x0) * k, (y1 - y0) * k);
}

function fromPhoto(fresh) {
  if (!photo) return;
  if (fresh || !subject) findPhotoSubject();
  // 先缩到 160 再缩到 40，比一步缩下去干净
  const mid = document.createElement("canvas");
  mid.width = mid.height = 160;
  const m = mid.getContext("2d");
  m.imageSmoothingQuality = "high";
  drawCrop(m, 160, cropRect());
  const small = document.createElement("canvas");
  small.width = small.height = HEAD * 4;
  const s = small.getContext("2d", { willReadFrequently: true });
  s.imageSmoothingQuality = "high";
  s.drawImage(mid, 0, 0, HEAD * 4, HEAD * 4);
  const crop = $("#crop").getContext("2d");
  crop.imageSmoothingQuality = "high";
  crop.clearRect(0, 0, 96, 96);
  crop.drawImage(mid, 0, 0, 96, 96);
  $("#colors-v").textContent = $("#colors").value;
  try {
    const skin = pixelize(s.getImageData(0, 0, HEAD * 4, HEAD * 4), {
      colors: Number($("#colors").value),
      removeBg: $("#removebg").checked,
      outline: $("#outline").checked,
      name: $("#name").value.trim() || "我的皮肤",
      bg: subject.bg,
    });
    // 拖滑条重新出底稿时，配件的勾选留着；脖子上的东西用的是旧调色板，不留
    const keep = work && !fresh ? { legs: work.legs, hat: work.hat, tail: work.tail, dots: work.dots } : null;
    load(skin, editing);
    if (keep) { Object.assign(work, keep); paintSide(); changed(); }
    status("底稿出来了，下面格子上接着修");
    return true;
  } catch (err) {
    status(err.message, true);
    return false;
  }
}
// 拖一下滑条只记一步撤销
for (const id of ["colors", "zoom", "offx", "offy"]) {
  $("#" + id).addEventListener("input", () => { if (photo) { beginBurst("photo:" + id); fromPhoto(false); } });
  $("#" + id).addEventListener("change", endBurst);
}
for (const id of ["removebg", "outline"]) $("#" + id).addEventListener("change", () => { if (photo) { record(); fromPhoto(false); } });

// ---------- 存、分享、粘贴 ----------

function save() {
  const skin = build();
  if (editing >= 0) {
    const list = loadSkins();
    if (list[editing]) { list[editing] = skin; saveSkins(list); return editing; }
  }
  editing = addSkin(skin);
  return editing;
}

$("#save").onclick = () => {
  try { save(); paintMine(); status("存好了，回游戏菜单里就能看到"); } catch (err) { status(err.message, true); }
};
$("#play").onclick = () => {
  try { location.href = "./index.html?play=custom:" + save(); } catch (err) { status(err.message, true); }
};

function openIO(text, placeholder) {
  $("#io").classList.remove("hidden");
  const t = $("#io-text");
  t.value = text;
  t.placeholder = placeholder || "";
  $("#io-go").classList.toggle("hidden", Boolean(text));
  if (text) { t.focus(); t.select(); }
}
$("#io-close").onclick = () => $("#io").classList.add("hidden");

$("#share").onclick = async () => {
  try {
    const code = encodeSkin(build());
    const link = new URL("./index.html?skin=" + code, location.href).href;
    openIO(`${link}\n\n皮肤码：\n${code}`);
    try { await navigator.clipboard.writeText(link); status("链接复制好了，发给别人点开就能玩这个皮肤"); }
    catch { status("长按上面的框全选复制，发给别人点开就能玩"); }
  } catch (err) {
    status(err.message, true);
  }
};
$("#paste").onclick = () => openIO("", "把皮肤码、皮肤链接或者克写的 JSON 贴在这里");
$("#io-go").onclick = () => {
  try {
    const skin = decodeSkin($("#io-text").value);
    record();
    load(skin);
    $("#io").classList.add("hidden");
    status(`认出来了：「${skin.name}」，改好记得存`);
  } catch (err) {
    status(err.message, true);
  }
};

function paintMine() {
  const box = $("#mine");
  const list = loadSkins();
  box.innerHTML = list.length ? "" : '<p class="hint">还没有，捏好点「只存起来」</p>';
  list.forEach((skin, i) => {
    const row = document.createElement("div");
    row.className = "mine";
    const name = document.createElement("b");
    name.textContent = skin.name;
    const edit = document.createElement("button");
    edit.className = "btn";
    edit.textContent = "改";
    edit.onclick = () => { record(); load(skin, i); status(`在改「${skin.name}」，存的时候会覆盖它`); scrollTo({ top: 0, behavior: "smooth" }); };
    const del = document.createElement("button");
    del.className = "btn";
    del.textContent = "删";
    del.onclick = () => {
      if (!confirm(`删掉「${skin.name}」？`)) return;
      const next = loadSkins();
      next.splice(i, 1);
      saveSkins(next);
      if (editing === i) editing = -1;
      else if (editing > i) editing--;
      paintMine();
    };
    row.append(headIcon({ head: skin.head, pal: skin.palette }), name, edit, del);
    box.append(row);
  });
}

$("#spec").textContent = [
  "palette：调色板。每个颜色用一个字母或数字当名字，写成 #rrggbb，最多 16 个",
  "head：头，10 行，每行正好 10 个字，用调色板里的名字，「.」是透明",
  "happy：吃到糖那一下的头，格式跟 head 一样（可以不写）",
  "neck：系在下巴底下的东西，最多 5 行、每行 8 个字（可以不写）",
  "body / edge / label：身子、描边、名牌的颜色",
  "tail / dots：尾巴尖、身上小点的颜色（可以不写）",
  "legs / hat：写 true 就有小腿、戴巫师帽（可以不写）",
  "",
  "例子（小螃蟹）：",
  JSON.stringify(EXAMPLE, null, 2),
].join("\n");

// ---------- 预览：一条小蛇绕圈吃糖 ----------

const pv = $("#preview");
const pctx = pv.getContext("2d");
const PW = 12, PH = 7, PAD = 6;
const loop = [];
for (let x = 2; x <= 9; x++) loop.push([x, 1]);
for (let y = 2; y <= 5; y++) loop.push([9, y]);
for (let x = 8; x >= 2; x--) loop.push([x, 5]);
for (let y = 4; y >= 2; y--) loop.push([2, y]);
let headAt = 6, food = 12, happyUntil = 0, lastStep = 0;
const pxy = ([x, y]) => [PAD + x * CELL, PAD + y * CELL];

function preview(t) {
  if (t - lastStep > 220) {
    lastStep = t;
    headAt = (headAt + 1) % loop.length;
    if (headAt === food) { happyUntil = t + 600; food = (food + 9) % loop.length; }
  }
  pctx.fillStyle = PAL.Z;
  pctx.fillRect(0, 0, pv.width, pv.height);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    pctx.fillStyle = (x + y) % 2 ? "#151b45" : "#121840";
    pctx.fillRect(PAD + x * CELL, PAD + y * CELL, CELL, CELL);
  }
  const [fx, fy] = pxy(loop[food]);
  drawSprite(pctx, PUMPKIN, fx, fy + 1);
  if (look) {
    const body = Array.from({ length: 6 }, (_, i) => loop[(headAt - i + loop.length) % loop.length]);
    drawSnake(pctx, look, body, pxy, { t, happy: t < happyUntil });
  }
  requestAnimationFrame(preview);
}

// 开场：从「初始」的圆脸改起；带着 ?edit=序号 就直接改那一个
const editParam = new URLSearchParams(location.search).get("edit");
const saved = loadSkins();
if (editParam != null && saved[Number(editParam)]) load(saved[Number(editParam)], Number(editParam));
else load(blankSkin());
paintMine();
requestAnimationFrame(preview);
