# QQ × DeepSeek 机器人

基于 Koishi + OneBot（NapCat 网关）的 QQ 聊天机器人，提供 DeepSeek 对话、上下文记忆、权限与限流，支持 Docker Compose 一键部署。

## 快速开始（本地）
1. 安装 Node.js 18+（推荐 20）。
2. `cp .env.example .env`，填入 `DEEPSEEK_API_KEY`、`BOT_SELF_ID`、`ADMIN_IDS`、`ONEBOT_WS_URL` 等信息。
3. 安装依赖并编译：`npm ci && npm run build`。
4. 运行开发模式：`npm run dev`；或运行编译产物：`npm start`。

> 机器人默认仅在私聊或被 @ 时响应群聊消息，前缀默认 `/`。

## Docker Compose 部署
1. 按照 NapCat-Docker 指南准备 QQ 登录：
   - 执行 `docker compose up -d napcat` 后，访问 `http://<宿主机>:6099/webui` 完成扫码登录并在 NapCat 界面里开启 OneBot WebSocket（默认 `ws://0.0.0.0:3001`）。
2. 复制环境变量：`cp .env.example .env` 并填写。
3. 启动全部服务：
   ```bash
   docker compose up -d --build
   docker compose logs -f bot   # 查看机器人日志
   ```
4. 健康检查：`curl http://localhost:5140/healthz`。

### Compose 说明
- `napcat`：QQ 协议网关（OneBot），暴露 3001（WS）与 6099（WebUI）。持久化目录 `./napcat/config` 和 `./ntqq`。
- `bot`：Koishi 容器，读取 `.env`，与 NapCat 通过内网 `ws://napcat:3001` 通信，数据卷 `./data`。

## 关键能力
- DeepSeek 对话：多轮上下文、自动摘要压缩，超时/异常自动提示。
- 权限与风控：白名单模式、黑名单、敏感词拦截、用户/群/全局限流、频道静音。
- 会话控制：人格预设、重置上下文、用量统计。
- 观测：本地 `/healthz`、`/status` HTTP 端点与 Koishi 日志。

## 指令
- `/help` 查看帮助
- `/reset` 重置当前会话
- `/persona <name>` 切换人格（default/friendly/expert/concise）
- `/usage` 查看累计用量
- 管理员：`/config` `/allow <id>` `/deny <id>` `/status` `/mute-on` `/mute-off`

## 文件结构
- `src/index.ts`：Koishi 入口、DeepSeek 调用、上下文与权限逻辑。
- `docker-compose.yml`：NapCat + Koishi 双容器编排。
- `.env.example`：环境变量模板。
- `koishi.yml`：可选 Koishi 配置模板（供 CLI/控制台使用）。
- `Dockerfile`：两阶段构建并提供健康检查。

## 环境变量要点
- `DEEPSEEK_API_KEY`（必填）、`DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL`。
- `ONEBOT_WS_URL`（默认 `ws://napcat:3001`）、`BOT_SELF_ID`、`ONEBOT_ACCESS_TOKEN`（若有）。
- `ADMIN_IDS`、`WHITELIST_MODE`、`BLOCKED_PATTERNS`、`USER_RATE_LIMIT` 等控制项见 `.env.example`。

## 运行时行为
- 群聊仅在被 @ 时响应；私聊直接响应。设置 `ALLOW_GROUP_PLAIN=true` 可放开群内无 @ 对话。
- 历史超过 `SUMMARY_TRIGGER` 自动摘要，截断旧消息，降低 token 成本。
- 每轮对话串行处理，防止同一会话乱序。
- `/status` 或 `/healthz` 可用于探活与监控。

## 迁移与升级
- 配置与数据存放于 `data/`、`napcat/`、`ntqq/` 卷中，`docker compose pull && docker compose up -d` 可平滑升级。

如需自定义插件、模型或风控策略，可在 `src/index.ts` 中扩展对应逻辑后重新构建镜像。
