# Greedy-Snake · AI 能玩的贪吃蛇

一个不用装任何依赖的网页贪吃蛇：自己玩、捏皮肤，也能开房间让 AI 下场——真的大模型在出手，不是写死的算法。
前端（网页）和后端（房间服务、AI 玩家、命令行）都在这个仓库里，装好 Node.js 就能跑。

A dependency-free web snake game that real language models can play. Frontend and backend (room server, AI players, CLI) are both included.

## 跑起来 · Run

需要 Node.js 24.14 或更新的版本。

```sh
node serve.mjs
```

打开 http://127.0.0.1:8790/ 。`serve.mjs` 同时提供网页和房间接口（`/api/ai-snake`）。
想让别的设备连进来：`AI_SNAKE_HOST=0.0.0.0 node serve.mjs`；换端口用 `AI_SNAKE_WEB_PORT`。
房间、回放和排行榜存在 `data/ai-snake/`。只要接口不要网页：`node games/ai-snake/server.mjs --port 8791`。

## 能玩什么 · Features

- **单人**：方向键 / WASD / 滑动；可以穿墙，也可以撞墙。
- **捏皮肤**：`maker.html` 里从内置小螃蟹或一张图片起头，在格子上改，生成皮肤码分享。
- **联机房间**：最多 4 个 AI + 2 个真人同场，地图随人数变大（15、19、23…35 格）。
  - 胜负：**生存赛**（活到最后）或 **限时积分赛**（按真实时间，到点比总分，出局也保留得分）。
  - 地图：**竞技场**，或 **无限漫游**（只加载蛇头附近，镜头跟着走，屏幕外的身子照样会撞）。
  - 规矩（照「贪吃蛇大作战」）：撞上别人身子的出局；头碰头不分长短一起出局，那一格谁也吃不到；蛇死了身子每一节变一颗大糖（2 分），谁抢到算谁的。
  - 奖励：南瓜糖 +1、金币 +3、糖果袋 +5、皇冠 +10；樱桃让你 10 回合内得分翻倍；雪花让其他蛇原地定住 3 回合，定住的整条当墙；
    金身盾牌让你 8 回合内别的蛇杀不死你——穿过别人身子、撞头对方出局，撞墙和咬到自己照样出局。
  - 排行榜、结算和回放。标了「测试机器人」的座位不上榜。

## 让 AI 下场 · AI players

建房时每个 AI 座位选一种：

1. **OpenCode Go（DeepSeek）**：设 `OPENCODE_GO_API_KEY`（或 `AI_SNAKE_OPENCODE_GO_API_KEY`），也会读当前用户已有的 OpenCode 配置和 `auth.json`。模型用 `AI_SNAKE_OPENCODE_MODEL` 指定，默认找 DeepSeek flash。开 AI 局会花模型额度。
2. **Ollama（本地模型）**：默认连 `http://127.0.0.1:11434`，用 `AI_SNAKE_OLLAMA_URL` / `OLLAMA_HOST` 改地址，`AI_SNAKE_OLLAMA_MODEL` 选模型（默认 `qwen3:8b`）。
   模型在另一台电脑上、端口转不过来时，可以在 `~/.ssh/config`（或 `AI_SNAKE_SSH_CONFIG` 指的文件）里配一个叫 `ollama-desktop` 的主机，房间服务会通过 SSH 把请求送过去。
3. **手动 AI**：座位留给外部程序，用命令行接管，见 `games/ai-snake/cli.mjs` 和 `games/ai-snake/ROOM_API.md`。

每个 AI 每次想一段路线（最多 32 步），提前续下一段，不会因为等它想而停住；一局能想几次按回合数算（8–40 次）。
同时最多跑 4 个自动 AI。AI 的每一步都是模型自己给的，接口不会替它出手；它没给的时候服务端只会沿原方向直走。

## 结构 · Layout

- `web/public/ai-snake/`：网页和唯一一份规则引擎 `engine.js`（网页、房间服务、命令行共用，同样的出手重放出来一模一样）。
- `games/ai-snake/server.mjs`：房间服务（零依赖 Node）。
- `games/ai-snake/bots/`：AI 玩家进程，以及 OpenCode / Ollama 的接法。
- `games/ai-snake/cli.mjs`：命令行，一步步下、看棋盘、接管手动座位。
- `serve.mjs`：网页 + 接口一起起。

只带内置的小螃蟹皮肤；不含任何存档、凭据或本机设置。
