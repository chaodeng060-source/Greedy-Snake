// 每个字符是一格像素，「.」是透明。
import { PRIVATE_PALETTE, PRIVATE_LOOKS, PRIVATE_LABELS } from "./private-sprites.js?v=20261031e";
export const ROOM_LABELS = { manual: "手动 AI", ...PRIVATE_LABELS };

export const PAL = {
  K: "#15121c", k: "#5a5180", V: "#5fd88a", W: "#eef0ff", N: "#f28aa0", m: "#8a7fb0",
  H: "#3556c4", h: "#213a8c", S: "#ffd23f",
  O: "#da7756", o: "#a9502f", E: "#1b1418", n: "#f6a0ae", p: "#f2a285",
  P: "#ff8c1a", q: "#c4560a", g: "#4a7a2a", G: "#ffe066",
  b: "#c3caef", X: "#1b1830", Z: "#07060d", r: "#ff4d4d",
  L: "#9be7ff", l: "#4b7fbf",
  ...PRIVATE_PALETTE,
};

export const CRAB_HEAD = [
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
];
export const CRAB_HAPPY = { 4: "OOOOOOOOOO", 5: "OEOEOOEOEO" };

// 巫师帽：画在头的上方，帽檐压住头顶两格。
export const HAT = [
  "....hH..",
  "...hHHH.",
  "...hHSH.",
  "..hHHHHH",
  ".hHHHSHH",
  "hhhhhhhh",
];

export const PUMPKIN = [
  "....g....",
  "...gg....",
  ".qqPPPqq.",
  "qPPPPPPPq",
  "qPGPPPGPq",
  "qPPPGPPPq",
  "qPGGGGGPq",
  ".qqqqqqq.",
];

export const GHOST = [
  "..WWWWW..",
  ".WWWWWWb.",
  "WWXWWWXWb",
  "WWXWWWXWb",
  "WWWWWWWWb",
  "WWWWXWWWb",
  "WWWWWWWWb",
  "WWWWWWWWb",
  "WW.WWW.Wb",
  "W...W...b",
];

export const BAT_UP = ["Z.......Z", "ZZ.ZZZ.ZZ", ".ZZZZZZZ.", "...Z.Z..."];
export const BAT_DOWN = ["...ZZZ...", ".ZZZZZZZ.", "ZZ.Z.Z.ZZ", "Z.......Z"];

// 小鬼：白色小幽灵。
export const GHOST_HEAD = [
  "..WWWWWW..",
  ".WWWWWWWb.",
  "WWWWWWWWWb",
  "WWXXWWXXWb",
  "WWXXWWXXWb",
  "WWWWWWWWWb",
  "WWWWXXWWWb",
  "WWWWWWWWWb",
  "WWWWWWWWWb",
  "WW.WW.WW.b",
];
export const GHOST_HAPPY = { 3: "WWWWWWWWWb", 4: "WXWXWWXWXb" };

// 蝙蝠：紫色小蝙蝠，红眼睛。
export const BAT_HEAD = [
  "Z........Z",
  "ZZ......ZZ",
  "ZmZ....ZmZ",
  "ZmmZZZZmmZ",
  "ZmmmmmmmmZ",
  "ZmrrmmrrmZ",
  "ZmrrmmrrmZ",
  "ZmmmWWmmmZ",
  ".ZmmmmmmZ.",
  "..ZZZZZZ..",
];
export const BAT_HAPPY = { 5: "ZmmmmmmmmZ", 6: "ZmrmmmmrmZ" };

// 内置外观与捏出的外观共用渲染格式。
export const SKIN_LOOK = {
  crab: { name: "小螃蟹", head: CRAB_HEAD, happy: CRAB_HAPPY, fill: "#b9603d", edge: "#7f3a20", hat: true, legs: true, label: "#ffb38f" },
  ...PRIVATE_LOOKS,
  ghost: { name: "小鬼", head: GHOST_HEAD, happy: GHOST_HAPPY, fill: "#eef0ff", edge: "#c3caef", hat: false, label: "#eef0ff" },
  bat: { name: "蝙蝠", head: BAT_HEAD, happy: BAT_HAPPY, fill: "#8a7fb0", edge: "#07060d", hat: false, label: "#c9b8ff" },
};

export const GOLD = ["...GGG...", "..GSSSG..", ".GSqSSSG.", ".GSSqSSG.", ".GSqSSSG.", "..GSSSG..", "...GGG..."];
// 大糖：蛇死了身子变的，一节一颗，粉白条纹的包装糖。
export const CANDY = [".........", "N..mWm..N", "NNmWNWmNN", "NNWNWNWNN", "NNmWNWmNN", "N..mWm..N"];
export const BAG = ["...qSq...", "....q....", "..qqSqq..", ".qSSSSSq.", "qSSSGSSSq", "qSSGGGSSq", ".qqqqqqq."];
// 道具：一对樱桃＝双倍，雪花＝冻结，皇冠＝10 分。
export const CHERRY = ["....g....", "...g.g...", "..g...g..", ".rr...rr.", "rWrr.rWrr", "rrrr.rrrr", ".rr...rr."];
export const SNOW = ["....L....", ".L..W..L.", "..LLWLL..", "LWWWLWWWL", "..LLWLL..", ".L..W..L.", "....L...."];
export const CROWN = ["S...S...S", "SS.SSS.SS", "SSSSSSSSS", "SrSSLSSrS", "SSSSSSSSS", ".qqqqqqq."];
// 金身：金色小盾牌，中间一道白十字。
export const SHIELD = ["qqqqqqqqq", "qGGGWGGSq", "qGGGWGSSq", "qWWWWWWWq", "qGGGWGSSq", ".qGGWSSq.", "..qGWSq..", "...qqq..."];

export function drawSprite(ctx, rows, x, y, override, alpha = 1, pal = PAL) {
  if (alpha !== 1) ctx.globalAlpha = alpha;
  rows.forEach((row, j) => {
    const r = override && override[j] ? override[j] : row;
    for (let i = 0; i < r.length; i++) {
      const c = r[i];
      if (c === ".") continue;
      ctx.fillStyle = pal[c] || PAL[c] || c;
      ctx.fillRect(x + i, y + j, 1, 1);
    }
  });
  if (alpha !== 1) ctx.globalAlpha = 1;
}
