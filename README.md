# QQ × DeepSeek 机器人（NapCat / OneBot + 自研轻量核心）

基于 **NapCat（QQ 网关）+ OneBot WebSocket** 接入 QQ 消息，调用 **DeepSeek Chat Completions API** 生成回复；提供多轮上下文、摘要压缩、权限/静音、三层限流与健康检查。

更系统的原理说明见：`doc/tech-understanding.md`。

## 快速开始（Docker Compose，推荐）

1. 复制并修改配置：
   ```bash
   cp .env.example .env
   ```
   必填/常用：
   - `DEEPSEEK_API_KEY`（必填）
   - `BOT_SELF_ID`（机器人 QQ 号，用于过滤自发消息与识别 @）
   - `ADMIN_IDS`（逗号分隔）
   - `ONEBOT_WS_URL`（默认 `ws://napcat:3001`，容器内地址）
   - `ONEBOT_ACCESS_TOKEN`（NapCat 若开启 token 需一致）

2. 启动 NapCat 并登录：
   ```bash
   docker compose up -d napcat
   ```
   打开 `http://<宿主机>:6099/webui` 扫码登录，并在 NapCat 中开启 OneBot WS 服务端（默认 3001，建议 `messagePostFormat=array`）。

3. 启动 Bot：
   ```bash
   docker compose up -d --build bot
   docker compose logs -f bot
   ```

4. 健康检查：
   ```bash
   curl http://localhost:5140/healthz
   ```

## 本地运行（开发）

要求：Node.js 18+（推荐 20）

```bash
npm ci
npm run dev
```

生产运行：
```bash
npm run build
npm start
```

## 使用说明

- 群聊默认 **需要 @ 触发**（否则忽略），可通过 `ALLOW_GROUP_PLAIN=true` 放开（风险更高）。
- 命令前缀默认 `/`（`BOT_PREFIX` 可改）。

### 指令

- `/help` 查看帮助
- `/reset` 重置当前会话上下文
- `/deep <问题>` 深度思考并回答（默认走 `DEEPSEEK_REASONER_MODEL`）
- `/persona <name>` 切换人格（default/friendly/expert/concise）
- `/usage` 查看累计用量
- 管理员：`/config` `/allow <id>` `/deny <id>` `/status` `/mute-on` `/mute-off`

## 数据与运维

- 持久化状态：`data/state.json`（白/黑名单、静音频道、累计用量）；会话上下文与限流为内存态，重启清零。
- HTTP 端点：`GET /healthz`、`GET /status`（端口 `PORT`，默认 5140）。
- 管理脚本：`scripts/manage.sh`（stop/restart/rebuild 等）。
