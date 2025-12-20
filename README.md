# QQ × DeepSeek 机器人（NapCat + 自研轻量核心）

基于 NapCat/OneBot WebSocket 与自研低耦合核心（无 Koishi），提供 DeepSeek 对话、上下文记忆、权限与限流，支持 Docker Compose 一键部署。

## 快速开始（本地）
1. 安装 Node.js 18+（推荐 20）。
2. `cp .env.example .env`，填入 `DEEPSEEK_API_KEY`、`BOT_SELF_ID`、`ADMIN_IDS`、`ONEBOT_WS_URL` 等信息。
3. 安装依赖并编译：`npm ci && npm run build`。
4. 运行开发模式：`npm run dev`；或运行编译产物：`npm start`。

> 群聊默认需 @ 触发，私聊直接响应；前缀默认 `/`。

## Docker Compose 部署
1. 准备 NapCat：`docker compose up -d napcat`，访问 `http://<宿主机>:6099/webui` 扫码登录并开启 OneBot WS（默认 `ws://0.0.0.0:3001`）。
2. `cp .env.example .env` 并填写必需参数。
3. 启动：  
   ```bash
   docker compose up -d --build
   docker compose logs -f bot   # 查看机器人日志
   ```
4. 健康检查：`curl http://localhost:5140/healthz`。

### Compose 说明
- `napcat`：QQ 协议网关（OneBot），暴露 3001（WS）与 6099（WebUI）。持久化目录 `./napcat/config` 和 `./ntqq`。
- `bot`：自研核心容器，读取 `.env`，通过内网 `ws://napcat:3001` 连接 OneBot，数据卷 `./data`。

## 关键能力
- DeepSeek 对话：多轮上下文、摘要压缩，超时/异常自动提示。
- 权限与风控：白名单/黑名单、敏感词拦截、用户/群/全局限流、频道静音。
- 会话控制：人格预设、重置上下文、用量统计。
- 观测：`/healthz`、`/status` HTTP 端点，控制台结构化日志。
- 架构：低耦合/高内聚，OneBot 适配、AI 客户端、存储、限流均可依赖注入替换。

## 指令
- `/help` 查看帮助
- `/reset` 重置当前会话
- `/persona <name>` 切换人格（default/friendly/expert/concise）
- `/usage` 查看累计用量
- 管理员：`/config` `/allow <id>` `/deny <id>` `/status` `/mute-on` `/mute-off`

## 文件结构
- `src/index.ts`：OneBot 客户端、命令路由、DeepSeek 调用、上下文与权限逻辑。
- `docker-compose.yml`：NapCat + Bot 双容器编排。
- `.env.example`：环境变量模板。
- `Dockerfile`：两阶段构建并提供健康检查。

## 环境变量要点
- `DEEPSEEK_API_KEY`（必填）、`DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL`。
- `ONEBOT_WS_URL`（默认 `ws://napcat:3001`）、`BOT_SELF_ID`、`ONEBOT_ACCESS_TOKEN`（若有）、`ONEBOT_RECONNECT_MS`。
- `ADMIN_IDS`、`WHITELIST_MODE`、`BLOCKED_PATTERNS`、`USER_RATE_LIMIT` 等控制项见 `.env.example`。

## 运行时行为
- 群聊需 @，否则忽略（除非 `ALLOW_GROUP_PLAIN=true`）；私聊直接响应。
- 历史超过 `SUMMARY_TRIGGER` 自动摘要，截断旧消息，降低 token 成本。
- 同会话串行处理，防止乱序；限流命中会提示等待。
- `/status` 或 `/healthz` 可用于探活与监控。

## 迁移与升级
- 配置与数据存放于 `data/`、`napcat/`、`ntqq/` 卷中，`docker compose pull && docker compose up -d` 可平滑升级。

如需扩展指令、模型或存储，可在 `src/index.ts` 中替换/注入对应实现后重新构建镜像。
