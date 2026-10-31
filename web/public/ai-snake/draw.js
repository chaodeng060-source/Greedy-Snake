// 画一条蛇：游戏和捏皮肤的预览共用这一份，捏出来什么样，进游戏就是什么样。
import { PAL, HAT, GOLD, BAG, CANDY, CHERRY, SNOW, CROWN, SHIELD, drawSprite } from "./sprites.js?v=20261031e";

export const CELL = 10;

// 头顶空着几行：帽子往下压几格，才刚好扣在头上
export function hatLift(head) {
  let n = 0;
  while (n < head.length && /^\.*$/.test(head[n])) n++;
  return n;
}

// xy(cell) -> 这一格左上角的像素坐标
export function drawSnake(ctx, look, body, xy, { t = 0, happy = false, viewport = null } = {}) {
  if (!body.length) return;
  const pal = look.pal || PAL;
  const visible = (cell) => !viewport || inViewport(cell, viewport, 1);
  // 先描边、再填色：每节一个方块，相邻两节之间补一条桥，连成一根管子
  for (const [inset, color] of [[1, look.edge], [2, look.fill]]) {
    ctx.fillStyle = color;
    body.forEach((c, i) => {
      if (!visible(c)) return;
      const [px, py] = xy(c);
      ctx.fillRect(px + inset, py + inset, CELL - inset * 2, CELL - inset * 2);
      const n = body[i + 1];
      if (!n) return;
      const [qx, qy] = xy(n);
      if (Math.abs(n[0] - c[0]) + Math.abs(n[1] - c[1]) !== 1) return;
      const x0 = Math.min(px, qx), y0 = Math.min(py, qy);
      if (qy === py) ctx.fillRect(x0 + CELL / 2, py + inset, CELL, CELL - inset * 2);
      else ctx.fillRect(px + inset, y0 + CELL / 2, CELL - inset * 2, CELL);
    });
  }
  // 身上的小配件
  body.forEach((c, i) => {
    if (i === 0 || !visible(c)) return;
    const [px, py] = xy(c);
    if (look.dots && i % 3 === 0) { ctx.fillStyle = look.dots; ctx.fillRect(px + 4, py + 4, 2, 2); }
    if (look.tail && i === body.length - 1 && i > 1) {
      // 尾巴尖换个颜色、蓬起来
      ctx.fillStyle = look.tail; ctx.fillRect(px + 2, py + 2, 6, 6);
      ctx.fillStyle = look.edge; ctx.fillRect(px + 1, py + 4, 1, 2); ctx.fillRect(px + 8, py + 4, 1, 2);
    }
    if (look.legs) {
      const p = body[i - 1];
      ctx.fillStyle = look.edge;
      const wiggle = (Math.floor(t / 180) + i) % 2;
      if (p[1] === c[1]) { ctx.fillRect(px + 3 + wiggle, py, 1, 1); ctx.fillRect(px + 6 - wiggle, py + 9, 1, 1); }
      else { ctx.fillRect(px, py + 3 + wiggle, 1, 1); ctx.fillRect(px + 9, py + 6 - wiggle, 1, 1); }
    }
  });
  if (!visible(body[0])) return;
  const [hx, hy] = xy(body[0]);
  drawSprite(ctx, look.head, hx, hy, happy ? look.happy : null, 1, pal);
  if (look.neck) drawSprite(ctx, look.neck, hx + 1, hy + 9, null, 1, pal);
  if (look.hat) drawSprite(ctx, HAT, hx + 1, hy - 4 + hatLift(look.head));
}

export function headIcon(look) {
  const c = document.createElement("canvas");
  c.width = CELL; c.height = CELL;
  drawSprite(c.getContext("2d"), look.head, 0, 0, null, 1, look.pal || PAL);
  return c;
}

// expiresAt 使用引擎回合数；旧回放没有 rewards，仍能直接绘制。
export function drawRewards(ctx, rewards, xy, { t = 0, turn = 0, viewport = null } = {}) {
  for (const reward of rewards || []) {
    if (reward.expiresAt != null && reward.expiresAt <= turn) continue;
    if (viewport && !inViewport([reward.x, reward.y], viewport)) continue;
    const [x, y] = xy([reward.x, reward.y]);
    const urgent = reward.expiresAt != null && reward.expiresAt - turn < 8;
    const alpha = urgent && Math.floor(t / 140) % 2 ? 0.4 : 1;
    drawSprite(ctx, ({ bag: BAG, double: CHERRY, freeze: SNOW, big: CROWN, guard: SHIELD })[reward.kind] || GOLD, x, y + 1, null, alpha);
  }
}

// 大糖一闪一闪地轻轻跳，跟普通南瓜糖区分开。
export function drawRemains(ctx, remains, xy, { t = 0, viewport = null } = {}) {
  (remains || []).forEach(([x, y], i) => {
    if (viewport && !inViewport([x, y], viewport)) return;
    const [px, py] = xy([x, y]);
    const bob = Math.sin(t / 200 + i * 1.3) > 0.4 ? -1 : 0;
    drawSprite(ctx, CANDY, px, py + 2 + bob);
  });
}

// Global coordinates stay authoritative; the camera only limits drawing.
export function inViewport([x, y], view, margin = 0) {
  return x >= view.x - margin && x < view.x + view.width + margin && y >= view.y - margin && y < view.y + view.height + margin;
}
