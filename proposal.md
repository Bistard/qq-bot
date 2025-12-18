# QQ × DeepSeek 24/7 机器人 Proposal（Koishi.js × Docker 方案）

## 1. 目标与场景

在自购 Linux 服务器上，采用 **Docker / Docker Compose** 方式，24 小时稳定运行一个 QQ 聊天机器人。  
机器人可在群聊/私聊中进行自然语言对话，并通过 DeepSeek API 提供高质量回答；同时具备 **可部署、可升级、可观测、可控成本与安全合规能力**。

本方案明确采用：

- **Koishi.js** 作为机器人核心框架  
- **OneBot 协议 + QQ 网关（NapCat 等）** 作为 QQ 登录与协议层  
- **Docker Compose** 作为唯一部署与运维方式  

---

## 2. 总体架构（Docker-First）

### 2.1 架构说明

- **QQ 网关容器（OneBot 实现）**
  - 负责 QQ 登录、协议通信、心跳与风控
  - 对外暴露 OneBot WebSocket / HTTP 接口
  - 机器人不直接处理 QQ 登录逻辑

- **Koishi Bot 容器**
  - 基于 Node.js / TypeScript
  - 通过 OneBot 适配器接入 QQ 网关
  - 负责命令系统、会话管理、DeepSeek 调用与权限控制

- **存储卷（Volume）**
  - 持久化 Koishi 配置、会话摘要、统计信息
  - 支持 SQLite（默认）或可升级为 PostgreSQL / MongoDB

- **Docker Compose**
  - 统一管理容器生命周期
  - 支持一键启动、重启、升级、回滚

### 2.2 架构示意

```

┌──────────────┐
│   QQ 客户端   │
└──────┬───────┘
│
┌──────▼────────────────────┐
│  QQ 网关容器（NapCat 等）  │
│  - QQ 登录 / 协议 / 心跳   │
│  - OneBot v11 / v12 API   │
└──────┬────────────────────┘
│ WebSocket / HTTP
┌──────▼────────────────────┐
│   Koishi Bot 容器          │
│   - OneBot 适配器          │
│   - 命令 / 会话 / 权限     │
│   - DeepSeek API           │
│   - 插件系统               │
└──────┬────────────────────┘
│
┌──────▼─────────┐
│   数据卷 Volume │
│   - 配置 / 统计 │
│   - 会话摘要    │
└────────────────┘

```

---

## 3. 功能需求

### 3.1 QQ 接入与消息处理

- 通过 **Koishi OneBot 适配器** 接入 QQ 网关
- 支持：
  - 群聊 / 私聊
  - `@机器人的ID`、命令前缀触发
  - 基础事件（进群、退群、禁言、撤回等）
- QQ 网关与 Koishi 运行在同一 Docker 网络内，避免公网暴露

---

### 3.2 对话体验（Koishi 会话机制）

- 多轮对话上下文（按群 / 用户维度）
- 上下文裁剪与摘要压缩，降低 token 成本
- 引用回复支持
- 同一会话串行处理，避免乱序
- 并发会话隔离

---

### 3.3 DeepSeek AI 能力

- DeepSeek API Key 通过配置文件读取
- 模型参数可配置（temperature、max_tokens、system prompt）
- 超时 / 限流 / 5xx 错误自动降级
- 可选流式输出（分段消息模拟）

---

### 3.4 命令系统（Koishi 原生）

**用户命令示例：**
- `/help`
- `/reset`
- `/persona <name>`
- `/usage`

**管理员命令示例：**
- `/config`
- `/allow` `/deny`
- `/status`
- `/mute-on`

命令权限基于 Koishi 权限系统统一管理。

---

### 3.5 安全、风控与合规

- **权限分级**：群主 / 管理员 / 白名单 / 普通用户
- **频控与限流**：按用户 / 群 / 全局配置
- **内容安全**：
  - 敏感词与正则拦截
  - AI 输出二次过滤
- **隐私保护**：
  - 默认不存储完整聊天原文
  - 仅存摘要或统计信息
  - 提供数据清理命令（可选）

---

### 3.6 插件化与扩展能力（Koishi 优势）

- Koishi 插件体系作为统一扩展机制
- 可选扩展方向：
  - 工具类（天气、汇率、提醒）
  - 文档问答 / RAG
  - 群管理与自动化
- 插件可通过 Docker Volume 持久化配置

---

## 4. 非功能需求（Docker 强制项）

- **高可用**：
  - Docker `restart: always`
  - 容器异常自动拉起
- **资源控制**：
  - 容器 CPU / 内存限制
  - 防止异常对话导致 OOM
- **可升级**：
  - 配置与镜像分离
  - `docker compose pull && up -d` 平滑升级
- **可迁移**：
  - 任意 Linux 服务器复制目录即可部署

---

## 5. 部署与运维（交付物）

- `docker-compose.yml`
  - QQ 网关服务
  - Koishi Bot 服务
- `.env.example`
  - DeepSeek API Key
  - 管理员 QQ
  - 模型与限流参数
- `koishi.yml`
  - Koishi 插件与平台配置
- 运维命令规范：
  - 启动：`docker compose up -d`
  - 查看日志：`docker compose logs -f`
  - 更新：`docker compose pull && docker compose up -d`

---

## 6. 里程碑

### MVP（可用）
- Docker Compose 启动
- Koishi + OneBot 接入
- 基础群聊 / 私聊 AI 对话
- `/help` `/reset`

### V1（可运营）
- 权限与限流
- 会话摘要
- 管理命令
- 错误降级与日志

### V2（可扩展）
- 插件体系完善
- RAG / 工具调用
- 输出安全增强

---

## 7. 验收标准

- Docker 环境下连续运行 7×24 小时
- 容器异常可自动恢复
- QQ 群内 @ 机器人可稳定响应
- DeepSeek 异常不阻塞系统
- 一条命令完成部署 / 升级 / 重启
