# Greedy-Snake · AI 能玩的贪吃蛇

一个不用装任何依赖的网页贪吃蛇：自己玩、捏皮肤，也能开房间让 AI 下场——真的大模型在出手，不是写死的算法。
前端（网页）和后端（房间服务、AI 玩家、命令行）都在这个仓库里，装好 Node.js 就能跑。

A dependency-free web snake game that real language models can play. Frontend and backend (room server, AI players, CLI) are both included.

## 跑起来 · Run

需要 Node.js 20 或更新（20、22、24 都实测过），不用 `npm install`，没有任何依赖。

```sh
node serve.mjs
```

打开 http://127.0.0.1:8790/ 。`serve.mjs` 同时提供网页和房间接口（`/api/ai-snake`）。
想让别的设备连进来：`AI_SNAKE_HOST=0.0.0.0 node serve.mjs`；换端口用 `AI_SNAKE_WEB_PORT`。
房间、回放和排行榜存在 `data/ai-snake/`。只要接口不要网页：`node games/ai-snake/server.mjs --port 8791`。

## 能玩什么 · Features

- **单人**：方向键 / WASD / 滑动；可以穿墙，也可以撞墙。
- **捏皮肤**：`maker.html` 里从内置的小螃蟹、小鬼、蝙蝠或一张图片起头，在格子上改，生成皮肤码分享。
- **联机房间**：最多 4 个 AI + 2 个真人同场，地图随人数变大（15、19、23…35 格）。
  - 胜负：**生存赛**（活到最后）或 **限时积分赛**（按真实时间，到点比总分，出局也保留得分）。
  - 地图：**竞技场**，或 **无限漫游**（只加载蛇头附近，镜头跟着走，屏幕外的身子照样会撞）。
  - 规矩（照「贪吃蛇大作战」）：撞上别人身子的出局；头碰头不分长短一起出局，那一格谁也吃不到；蛇死了身子每一节变一颗大糖（2 分），谁抢到算谁的。
  - 奖励：南瓜糖 +1、金币 +3、糖果袋 +5、皇冠 +10；樱桃让你 10 回合内得分翻倍；雪花让其他蛇原地定住 3 回合，定住的整条当墙；
    金身盾牌让你 8 回合内别的蛇杀不死你——穿过别人身子、撞头对方出局，撞墙和咬到自己照样出局。
  - 排行榜、结算和回放。标了「测试机器人」的座位不上榜。

## 让 AI 下场 · AI players

建房时每个 AI 座位选一种（网页里只列出这台服务器真配了的）：

1. **任意 OpenAI 兼容接口**（DeepSeek 官方、通义千问、OpenAI、OpenRouter、自己搭的 vLLM……），全部在服务器上用环境变量配，浏览器传不进地址和钥匙：
   - `AI_SNAKE_OPENAI_BASE_URL`：接口地址，比如 `https://api.deepseek.com/v1`
   - `AI_SNAKE_OPENAI_API_KEY`：钥匙（本地服务不需要可以不填）
   - `AI_SNAKE_OPENAI_MODEL`：开放给玩家选的模型，一个或逗号分隔几个，比如 `deepseek-chat`；建房只能选这里列的
   - 可选：`AI_SNAKE_OPENAI_HEADERS`（额外请求头，JSON 对象）、`AI_SNAKE_OPENAI_JSON_MODE=0`（接口不支持 JSON 模式时关掉）、`AI_SNAKE_OPENAI_REASONING_EFFORT`（支持的模型可设 `none`/`low` 省时间）
2. **OpenCode Go（DeepSeek）**：设 `OPENCODE_GO_API_KEY`（或 `AI_SNAKE_OPENCODE_GO_API_KEY`），也会读当前用户已有的 OpenCode 配置和 `auth.json`。模型用 `AI_SNAKE_OPENCODE_MODEL` 指定，默认找 DeepSeek flash。开 AI 局会花模型额度。
3. **Ollama（本地模型）**：默认连 `http://127.0.0.1:11434`，用 `AI_SNAKE_OLLAMA_URL` / `OLLAMA_HOST` 改地址，`AI_SNAKE_OLLAMA_MODEL` 选模型（默认 `qwen3:8b`）。
   模型在另一台电脑上、端口转不过来时，可以在 `~/.ssh/config`（或 `AI_SNAKE_SSH_CONFIG` 指的文件）里配一个叫 `ollama-desktop` 的主机，房间服务会通过 SSH 把请求送过去。
4. **手动 AI**：座位留给外部程序（别的 AI 代理、脚本），用命令行或 HTTP 接口接管，见 `games/ai-snake/cli.mjs` 和 `games/ai-snake/ROOM_API.md`。不花这台服务器任何模型钱。

`AI_SNAKE_PROVIDERS=openai,ollama` 这样写可以只开放其中几个通道；写 `AI_SNAKE_PROVIDERS=manual` 就只剩真人和手动 AI。

每个 AI 每次想一段路线（最多 32 步），提前续下一段，不会因为等它想而停住；一局能想几次按回合数算（8–40 次）。
同时最多跑 4 个自动 AI。AI 的每一步都是模型自己给的，接口不会替它出手；它没给的时候服务端只会沿原方向直走。

## 部署到自己的服务器 · Deploy

```sh
git clone https://github.com/chaodeng060-source/Greedy-Snake.git
cd Greedy-Snake
AI_SNAKE_HOST=0.0.0.0 AI_SNAKE_WEB_PORT=8790 node serve.mjs
```

浏览器打开 `http://服务器地址:8790/`，网页、捏皮肤（`/maker.html`）和房间接口都由这一个进程提供。

**挂在网站的子路径下**（比如 `https://example.com/snake/`）：网页按相对路径找接口，反向代理把前缀去掉转过来就行。nginx：

```nginx
location /snake/ {
    proxy_pass http://127.0.0.1:8790/;
}
```

这时 `serve.mjs` 不用对外，`AI_SNAKE_HOST` 保持默认的 `127.0.0.1`。

**开机自启**（systemd，路径和用户按自己的改；模型钥匙放进 `EnvironmentFile`，别写进仓库）：

```ini
[Unit]
Description=Greedy-Snake
After=network-online.target

[Service]
WorkingDirectory=/srv/Greedy-Snake
ExecStart=/usr/bin/node serve.mjs
EnvironmentFile=/etc/greedy-snake.env
Restart=on-failure
User=snake

[Install]
WantedBy=multi-user.target
```

**数据**：房间、回放和排行榜都在 `data/ai-snake/`，备份这个目录就行。

**放到公网前要知道**：

- 没有登录，谁打开网页都能开 AI 房间，花的是服务器主人配的模型钥匙。上限是同时最多 8 个房间、4 个自动 AI；一个 AI 一局最多想 40 次，每次大约 1.3k 输入 + 几十个输出 token。
- 不想让访客花钱：`AI_SNAKE_PROVIDERS=manual`，只剩真人和外部程序接管的手动 AI。
- 钥匙只从服务器环境变量读，接口回给浏览器的东西里不带钥匙。

## 结构 · Layout

- `web/public/ai-snake/`：网页和唯一一份规则引擎 `engine.js`（网页、房间服务、命令行共用，同样的出手重放出来一模一样）。
- `games/ai-snake/server.mjs`：房间服务（零依赖 Node）。
- `games/ai-snake/bots/`：AI 玩家进程，以及 OpenCode / Ollama 的接法。
- `games/ai-snake/cli.mjs`：命令行，一步步下、看棋盘、接管手动座位。
- `serve.mjs`：网页 + 接口一起起。

内置三款皮肤：小螃蟹、小鬼（白色小幽灵）、蝙蝠；不含任何存档、凭据或本机设置。
