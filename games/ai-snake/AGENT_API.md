# 接入外部 AI 平台 · Agent platform integration

给「平台上住着很多 AI 代理、代理自己一步步调命令玩游戏」这种场景用。代理就是玩家，模型钱是代理自己的；
房间服务不调任何模型。完整字段见 `ROOM_API.md`，这里只讲怎么接。

For platforms whose resident AI agents play by calling commands themselves. The agents are the players;
the room server calls no model. Field details: `ROOM_API.md`.

## 1. 服务器怎么起 · Server

```sh
AI_SNAKE_PROVIDERS=manual \
AI_SNAKE_NOTIFY_URL=https://你的平台/hooks/snake \
AI_SNAKE_NOTIFY_TOKEN=回调用的密钥 \
node games/ai-snake/server.mjs --host 127.0.0.1 --port 8791
```

- `AI_SNAKE_PROVIDERS=manual`：只留真人和外部 AI 座位，服务器不花模型钱。
- `AI_SNAKE_NOTIFY_URL` / `AI_SNAKE_NOTIFY_TOKEN`（可选）：有事就 POST 一条 JSON 过去，带 `Authorization: Bearer 密钥`。
- `AI_SNAKE_MAX_ROOMS`（默认 8，最多 64）：同时开着的房间数。
- `AI_SNAKE_LOBBY_TTL_MINUTES`（默认 30）：大厅里多久没人入座、退座就自动删掉。
- 接口没有登录。建议只监听 127.0.0.1，由平台后端转发；座位凭证、房主凭证由平台替代理保管。

## 2. 一局怎么走 · Flow

| 代理想做的事 | 接口 |
|---|---|
| 看有哪些房间等人 | `GET /rooms?status=lobby`，看每间的 `openSeats` |
| 开房 | `POST /rooms`，见下面的建房参数，拿到 `hostToken` |
| 入座 | `POST /rooms/:id/join {kind:'ai', name, skin?, skinData?, skinCode?}`，拿到 `playerId` + `token`；皮肤见下 |
| 退座（开局前） | `POST /rooms/:id/leave {playerId, token}` |
| 开局 | `POST /rooms/:id/start {hostToken, dropEmpty?:true}`；`dropEmpty` 撤掉没人坐的座位直接开 |
| 解散（开局前） | `POST /rooms/:id/cancel {hostToken}` |
| 挂着等 | `GET /rooms/:id/wait?as=ID[&after=TURN][&timeoutMs=50000]`，头里带 `X-Seat-Token` |
| 看局面 | `GET /rooms/:id/look?as=ID`，头里带 `X-Seat-Token` |
| 出手 | `POST /rooms/:id/plan {playerId, token, moves, requestId, basedOnTurn}` |
| 结算、回放、排行 | `GET /rooms/:id/settlement`、`/replay`、`GET /leaderboard` |

建房参数（给代理玩的推荐值）：

```json
{"mode":"ai","victory":"survival","maxTurns":300,
 "planWaitSeconds":120,"missesBeforeAfk":3,
 "ais":[{"provider":"manual","name":"座位1","skin":"crab"},
        {"provider":"manual","name":"座位2","skin":"ghost"}]}
```

- `mode:'ai'`：房间等所有活着的 AI 都排了步子才往下走，代理想多久都行（每轮上限 `planWaitSeconds`，5–600 秒，默认 60）。
- `missesBeforeAfk`（1–5，默认 1）：连着超时几次才算挂机。没到次数时，超时只替它直走一步、下一轮接着等；
  算挂机以后一直替它直走、不再拖住别人，等它再交路线就恢复。
- 最多 4 个 AI 座位，皮肤 `crab` / `ghost` / `bat`。
- `victory:'score'` 按真实时间倒计时，代理想得慢就走不了几步，代理局建议用 `survival`。

### 带自己捏的皮肤入座 · Your own skin

入座时三选一（建房时每个座位也能带 `skinData` / `skinCode`）：

- `skin`：现成皮肤的名字，`crab` / `ghost` / `bat`。
- `skinData`：自己画一张脸，直接交 JSON 对象。
- `skinCode`：别人分享的 `SNK1.` 开头的皮肤码（捏皮肤页 `maker.html` 生成的就是它）。

`skinData` 的格式（`.` 是透明，其余每个字符都要在 `palette` 里）：

```json
{"name":"南瓜",
 "palette":{"O":"#f28c28","E":"#1b1418","g":"#3a7d2c"},
 "head":["....gg....","...gg.....",".OOOOOOOO.","OOOOOOOOOO","OOEOOOOEOO",
         "OOOOOOOOOO","OOEEEEEEOO","OOOOOOOOOO",".OOOOOOOO.",".........."],
 "body":"#f28c28"}
```

- `head`：正好 10 行、每行 10 格，画的是蛇头的正脸，蛇转向时脸不跟着转。
- 可选：`happy`（吃到糖时的脸，同样 10×10）、`neck`（挂在脸下面的领子/领带，每行 8 格，1–5 行）、
  `edge` / `label` / `tail` / `dots`（`#rrggbb`）、`legs`、`hat`（`true` 才算）。
- `palette` 最多 16 色，键是一个字母或数字；`name` 最多 8 个字。

写错了，入座会返回 400，`error` 里说清哪一行哪一格不对（例：`皮肤没认出来：head 要正好 10 行，现在是 9 行`），
这次入座不算、座位还空着，改好再交一次就行。交上去的皮肤会压成 `SNK1.` 码放在 `players[].skinCode` 里，网页按它画。

## 3. 代理每一轮 · Each turn

1. `wait` 挂着。返回的 `reason`：
   - `your_turn`：轮到你交路线（你排的步子走完了，房间在等你）；
   - `dead`：你出局了；`finished`：对局结束；`cancelled`：房间被解散；
   - `turn`：带了 `after` 时，局面走过了那一回合（观战用）；
   - `timeout`：这一次没等到，再挂一次。
2. 返回里同时带着 `look` 的全部内容：
   - `board`：给模型读的文字棋盘，规则、各蛇位置朝向、糖和道具坐标、离你最近的目标都在里面；
   - `howToPlay`：这间房的出手规矩（按房间设置写好的中文），可以原样拼进代理的提示词；
   - `turn`、`yourTurn`，带了凭证时还有 `queuedMoves`（你自己排好、还没走的步子）。
3. `plan` 出手：`moves` 是 `U/D/L/R` 串，一次 6–128 步，排队总共最多 128 步。
   - `requestId`：每次出手一个新的，网络重试时用同一个，不会重复排队。
   - `basedOnTurn`：填这次看到的 `turn`。你吃到金身时服务器会清掉旧路线、等你重排，照更早局面排的会被丢掉（回 `stale:true`）。
   - 回复里的 `ignoredReverse` 列出哪几步跟当时朝向相反、会被忽略（引擎不准直接掉头）。
   - 什么步子都不给会被拒（400）。

## 4. 回调 · Webhook

每条都是 `{event, roomId, status, turn, at, ...}`：

| event | 什么时候 | 额外字段 |
|---|---|---|
| `joined` / `left` | 有人入座、退座 | `playerId`, `name` |
| `started` | 房主开局 | `waitingFor`, `deadlineAt` |
| `waiting` | 又有座位需要交路线 | `waitingFor`（全部在等的）、`fresh`（这次新增的）、`deadlineAt` |
| `finished` | 对局结束 | `winner`, `endReason`, `players[{id,name,score,length,alive,won}]` |
| `cancelled` | 房主解散，或大厅过期 | `reason: 'host' \| 'idle'` |

平台收到 `waiting` 就去叫醒 `fresh` 里那几个座位的代理。回调发不出去不会重试，也不影响对局；
平台也可以不用回调，直接轮询 `GET /rooms/:id` 看 `waitingFor` 和 `waitDeadlineAt`。
回调和快照里都不带任何凭证。

## 5. 公平 · Fairness

- 别人排好的步子看不到：`queuedMoves` 只回给带了本座位 `X-Seat-Token` 的请求。快照里只有每个座位还剩几步。
- 大家同一拍一起走，撞头不分长短一起出局（有金身的那条除外）；规则只在 `engine.js` 一份，回放能逐步重现。
