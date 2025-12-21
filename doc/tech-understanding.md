# 技术理解文档：QQ × DeepSeek 机器人（NapCat / OneBot + 自研轻量核心）

本文档面向**有工程经验的接手开发者**，目标是让你在不依赖原作者口述、且面对“AI 生成代码风格不稳定”的情况下，依然能建立清晰的**概念体系**与**系统心智模型**：知道项目为什么这样拆、消息如何流、状态在哪里、改动从哪下手、踩坑点在哪。

> 项目一句话：通过 **NapCat（QQ 协议网关）** 将 QQ 消息转换成 **OneBot 事件流**，本项目作为 OneBot WS 客户端接收消息并调用 **DeepSeek Chat Completions API** 生成回复，再通过 OneBot 动作发回 QQ；同时提供最小化的权限、限流、会话上下文与持久化状态能力。

---

### 1. 项目整体概览（Big Picture）

#### 项目目标与使用场景

- **目标**：在 QQ（群聊/私聊）里提供一个由 DeepSeek 驱动的对话机器人，支持多轮上下文、深度思考、基础风控与运维可观测性。
- **典型场景**：
    - 群内问答/知识助手（默认要求 @ 触发，避免打扰）。
    - 私聊助手（默认直接响应）。
    - 运营/管理需要：白名单/黑名单、频道静音、简单用量统计与健康检查。

#### 核心设计思想

- **低依赖、轻框架**：仅依赖 `ws`，避免引入 Koishi 等完整框架，把“机器人到底做什么”收敛成可读的几层模块。
- **分层与可替换**：关键外部依赖抽象成接口：
    - `ILLMClient`（LLM 客户端）可以替换为别的模型/供应商。
    - `IStore`（状态存储）可以替换为数据库/Redis。
- **把复杂性放在“边界”**：QQ 协议由 NapCat 处理；本项目只需要理解 OneBot 事件/动作；LLM 调用封装在客户端里。

#### 与传统/被动系统的关键区别

- **事件驱动而非请求驱动**：不是“收到 HTTP 请求才执行”，而是持续保持 WebSocket 连接，按消息事件触发处理链路。
- **长连接与重连语义是常态**：网关重启、网络波动会频繁出现；系统必须可恢复、可重连。
- **“状态”是产品能力的一部分**：上下文记忆、限流计数、权限名单都属于运行时状态；其中一部分必须落盘持久化，一部分可以只在内存中维护。

---

### 2. 系统架构与组件拆解

#### 总体架构图的文字描述

可以把系统理解为三段链路：

1. **QQ 侧**（不可控、协议复杂）
2. **网关侧（NapCat）**：QQ 协议 ↔ OneBot 事件/动作
3. **业务侧（本项目）**：OneBot 消息 → 策略/上下文 → DeepSeek → OneBot 回复

数据与控制流的“主干”如下：

```
QQ 客户端/群聊
   │
   ▼
NapCat (容器/宿主运行，负责 QQ 协议与登录态)
   │  OneBot 事件 (WebSocket)
   ▼
本项目 Bot Core (Node.js/TS)
   │  DeepSeek Chat Completions (HTTP)
   ▼
DeepSeek API
```

同时存在两类“侧路”：

- **本地持久化**：`data/state.json` 保存白/黑名单、静音频道、用量。
- **运维探活**：HTTP `GET /healthz` 与 `GET /status`。

#### 各主要组件的职责边界（按模块划分）

- **入口与编排层：`src/index.ts`**
    - 组装依赖：配置、存储、LLM、会话、限流、锁、命令注册、OneBot 客户端、健康检查。
    - 核心消息处理流水线：过滤 → 鉴权 → 风控 → 命令/对话分流 → 调用 LLM → 发回消息。
- **OneBot 适配层：`src/onebot.ts`**
    - 作为 WebSocket 客户端连接 OneBot 网关（NapCat）。
    - 将 OneBot 原始事件解析为内部 `ParsedMessage`（统一字段：userId/groupId/plainText/segments/@mention 等）。
    - 提供 `sendText()` 将回复以 OneBot 动作发回（群聊/私聊自动选择不同 action）。
- **LLM 调用层：`src/deepseek.ts`**
    - `ILLMClient` 接口：约束“给消息列表 -> 得到文本/用量”的调用模型。
    - `DeepseekClient`：对接 `POST /v1/chat/completions`，控制超时、模型、温度、max_tokens。
- **会话与上下文层：`src/conversation.ts`**
    - 维护每个会话（群/私聊维度）的 history、summary、persona。
    - 负责构建 prompt（system + persona + 摘要 + 最近消息）。
    - 负责摘要压缩与用量写入。
- **命令系统：`src/commands.ts`**
    - `CommandRegistry`：命令注册与执行分发。
    - 内置命令：reset/deep/persona/usage/mute-on/mute-off/allow/deny/config/status/help。
- **风控与一致性：**
    - `src/limiter.ts`：用户/群/全局三层限流（内存滑动窗口近似）。
    - `src/lock.ts`：按会话 key 串行执行，避免同一会话并发导致上下文乱序。
- **状态持久化：`src/store.ts`**
    - `data/state.json`：白名单、黑名单、静音频道、累计用量。
    - 提供“权限判断”的单一真相：`isAllowed()` / `isDenied()`。
- **配置与工具：`src/config.ts` / `src/utils.ts` / `src/types.ts`**
    - 环境变量 → 强类型配置对象；解析数字、逗号分隔列表、正则列表等。

#### 组件之间的依赖关系与通信方式

- **Bot Core ↔ NapCat**：WebSocket（OneBot 事件/动作，JSON）。
- **Bot Core ↔ DeepSeek**：HTTP（Chat Completions，JSON）。
- **Bot Core ↔ Filesystem**：读写 `data/state.json`（持久化状态）。
- **Docker Compose**：
    - `napcat` 暴露 3001（OneBot WS）与 6099（WebUI）。
    - `bot` 暴露 5140（健康检查/状态）。

---

### 3. 关键技术与知识前置

这一节不是教程，而是列出“读懂本项目必须具备的概念”，并解释它们在这里承担什么职责。

#### Node.js + TypeScript（本项目的运行时基础）

- **为什么需要**：业务核心用最少依赖实现；TypeScript 用于把消息结构、配置、接口边界显式化，降低 AI 生成代码带来的不可控性。
- **在这里的职责**：
    - Node 负责：事件循环、并发 I/O（WS/HTTP/文件）。
    - TS 负责：接口抽象（`ILLMClient`、`IStore`）、结构化类型（OneBot event）。

#### WebSocket（OneBot 的承载通道）

- **为什么需要**：机器人需要实时接收消息；WS 提供长连接、低延迟、双向通信。
- **在这里的职责**：
    - NapCat 作为 OneBot WS **服务端**（典型“正向 WS”模式）：本项目连接它并收事件。
    - 本项目实现重连：网络抖动时自动恢复监听（`OneBotClient.scheduleReconnect()`）。

#### OneBot 协议（QQ 机器人领域的“消息/动作统一语义”）

- **为什么需要**：QQ 原生协议私有且复杂；OneBot 提供统一的事件（message 等）与动作（send_group_msg 等）语义，便于替换底层实现。
- **在这里的职责**：
    - **事件结构**：`post_type=message`、`message_type=group/private`、`user_id`、`group_id`、`message`（segments）等。
    - **动作结构**：`{ action, params, echo }` 通过 WS 发送到网关。
    - **消息段（segments）**：决定能否识别 `@`、提取纯文本、引用回复等。

#### Koishi（可选：对比参照/历史遗留，不是当前运行核心）

- **为什么会出现在仓库里**：你会看到 `koishi.yml`、以及部分 NapCat 配置/日志里出现 `koishi` 字样，这是因为 Koishi 是国内常用的机器人框架，常与 OneBot + NapCat 组合使用。
- **在这里的真实角色**：
    - **当前运行链路不依赖 Koishi**：本项目用自研轻量核心直接对接 OneBot WS，不需要 Koishi 的插件系统与运行时。
    - `koishi.yml` 更像“备用配置”：当你想用 Koishi CLI/控制台做调试或对比实现时可用，但它不是默认部署的一部分。
- **你需要掌握到什么程度**：
    - **理解概念即可**：Koishi 提供“插件化的事件驱动机器人框架”，OneBot 只是其中一个适配器；本项目把这些能力拆成了更小的模块（命令、会话、存储、限流等）。
    - **不必读 Koishi 源码**，除非你计划把本项目迁移回 Koishi 生态或复用 Koishi 插件。

#### NapCat（QQ 协议网关 / OneBot 实现）

- **为什么需要**：它负责扫码登录、保持 QQ 登录态、处理 QQ 协议细节，并把消息映射成 OneBot。
- **在这里的职责**：
    - 维护 QQ 侧 session（容器内持久化到 `./ntqq`）。
    - 提供 OneBot WS 服务（默认 3001）以及 WebUI（6099）用于配置与运维。
- **工程上必须理解的点**：
    - NapCat/OneBot 往往有**“正向 WS / 反向 WS（Reverse WS）”两种部署模型**：
        - 正向：Bot 连接 NapCat（本项目使用这种）。
        - 反向：NapCat 主动连接 Bot（本项目**没有实现** OneBot WS Server，不能用这种）。
    - `messagePostFormat=array` 很关键：本项目依赖 segments 才能识别 `@` 与提取 text。

#### DeepSeek Chat Completions API（LLM 生成能力）

- **为什么需要**：机器人回复的核心能力来源。
- **在这里的职责**：
    - 输入：`messages: [{role, content}, ...]`，包含 system prompt、对话历史、摘要等。
    - 输出：`choices[0].message.content` 作为最终回复文本。
    - 用量：`prompt_tokens` / `completion_tokens` 用于本地累计统计（不是计费的唯一依据，但可做运营指标）。
- **工程上必须理解的点**：
    - **system prompt 是产品策略**：决定机器人语气、边界、安全策略，甚至输出格式（纯文本模式）。
    - **模型选择策略**：普通对话用 `DEEPSEEK_MODEL`；`/deep` 用 `DEEPSEEK_REASONER_MODEL` 并降低温度。
    - **超时与失败模式**：网络失败/超时属于常态，需要给用户可理解的错误提示。

#### Docker / Docker Compose（可部署性与依赖编排）

- **为什么需要**：NapCat 需要稳定运行环境与持久化卷；Bot 也需要与 NapCat 在同一网络，并可一键升级。
- **在这里的职责**：
    - `docker-compose.yml` 负责拉起双容器、声明网络、挂载卷、注入环境变量。
    - `Dockerfile` 负责构建 TS 编译产物与生产依赖，并提供健康检查。

#### “一致性控制”（锁 + 限流）在 Bot 场景中的意义

- **为什么需要**：
    - LLM 调用慢，多个消息同时进来会导致回复乱序、上下文错位、token 成本暴涨。
    - 群聊里容易出现短时爆发；需要限流保护外部 API 与自身稳定性。
- **在这里的职责**：
    - `LockManager`：同一会话 key（群/私聊）串行处理，保证“输入顺序 == 回复顺序”。
    - `RateLimiter`：用户/群/全局三层护栏，防止被刷与防止整体雪崩。

---

### 4. 运行时行为与系统生命周期

#### 启动到运行的完整流程（关键阶段）

1. **加载配置**：从环境变量构建 `BotConfig`（`src/config.ts`）。
2. **初始化持久化状态**：创建/读取 `data/state.json`（`src/store.ts`）。
3. **初始化业务依赖**：
    - DeepSeek 客户端（HTTP）
    - 会话管理器（内存）
    - 命令注册表（内存）
    - 限流器与锁（内存）
4. **连接 OneBot**：作为 WS 客户端连接 NapCat，并开始监听 message 事件（`src/onebot.ts`）。
5. **启动运维端口**：HTTP server 提供 `/healthz` 与 `/status`（`src/index.ts`）。

#### 初始化、连接、监听、处理、输出：各阶段发生了什么

- **连接阶段**：`OneBotClient.connect()` 建立 WS；成功后触发 `ready`；失败/断开会进入定时重连。
- **监听阶段**：收到 WS 消息后 JSON parse；筛选 `post_type === 'message'`；转换为内部消息结构并 emit `message`。
- **处理阶段**：`handleMessage()` 执行“策略流水线”（见第 5 节）。
- **输出阶段**：将文本回复包装成 OneBot segments（可带 reply 引用），调用 `send_group_msg` / `send_private_msg` 发回。

#### 关键运行时状态的变化

- **内存态（重启即丢）**：
    - 会话上下文（history/summary/persona）
    - 限流桶（每 key 的计数与 reset 时间）
    - 会话锁队列（同 key 的串行队列）
- **持久化态（跨重启保留）**：
    - 白名单/黑名单、静音频道、累计用量：`data/state.json`

---

### 5. 消息与数据流（非常重要）

把“收到一条 QQ 消息直到发出回复”视为一条严格的流水线。理解这条线，就能定位任何行为：为什么没回复、为什么限流、为什么上下文丢、为什么输出格式不对。

#### 消息进入系统后的完整路径（端到端）

1. **QQ 侧产生消息**（群聊/私聊）
2. **NapCat 将消息转成 OneBot 事件**（JSON，经 WS 推送）
3. **`OneBotClient` 解析事件**：
    - 过滤非 message 事件
    - 提取 `userId/groupId/messageId`
    - 从 segments 提取 `plainText`、检测是否 `@bot`
4. **`handleMessage()` 执行策略流水线**：
    - 静音检查（频道维度）
    - 群聊触发条件（默认需 @）
    - 权限检查（管理员/白名单/黑名单/白名单模式）
    - 敏感词/正则拦截（基于配置的 patterns）
    - 命令分流（前缀 `/`）
    - 非命令：三层限流（user/group/global）
    - 会话锁：同会话串行执行
5. **`ConversationManager.reply()` 构建对话上下文并调用 LLM**
6. **`OneBotClient.sendText()` 发送回复**（必要时分片）

#### 内部状态如何被更新（写入点）

- **会话状态（内存）**：
    - user 输入追加到 `history`
    - 触发摘要时更新 `summary`，并裁剪 `history`
    - assistant 回复追加到 `history`
    - persona 命令更新 `persona`
- **持久化状态（落盘）**：
    - allow/deny/mute/unmute：写入 `data/state.json`
    - usage：每次 LLM 调用（含摘要调用）会累加 tokens 与 messages

#### 决策与响应如何产生（两条主分支）

**A. 命令路径（以 `/help` 为例）**

- 识别前缀 → 解析命令名与参数 → 调用 `CommandRegistry.execute()`
- 命令处理通常**不调用 LLM**（除了 `/deep` 会走 LLM）
- 返回的文本同样会走“分片 + 引用回复 + 发回”

**B. 对话路径（普通聊天）**

- 通过限流 → 进入会话锁 → `ConversationManager.reply()`
- prompt 结构（概念级，不等同源码）：
    1. system：产品基线策略（`SYSTEM_PROMPT`）
    2. system：persona（可选）
    3. system：摘要（可选）
    4. system：纯文本约束（可选）
    5. system：深度思考指令（仅 `/deep`）
    6. recent history：最近 N 轮 user/assistant
- LLM 返回文本 → 追加到 history → 记录 usage → 返回给消息发送层

#### “会话 key”的意义：为什么按群/私聊隔离

- 会话 key 采用：
    - 群聊：`onebot:group:<groupId>`
    - 私聊：`onebot:dm:<userId>`
- 这决定了三件事：
    1. 上下文记忆的作用域（群内共享 vs 私聊独享）
    2. 串行锁的粒度（避免同一群内并发乱序）
    3. 静音/配置的作用域（按频道维度）

---

### 6. 配置、约定与隐含规则

本项目的“行为开关”几乎都在环境变量里，理解这些配置的**影响范围**与**默认值**非常关键。

#### 配置来源与优先级

- **环境变量**：运行时唯一输入（本地 `.env` 或 Compose `env_file`）。
- **持久化状态 `data/state.json`**：运行中通过命令修改后落盘，重启仍生效。
- **隐含规则**：某些配置只在首次初始化生效（见“名单种子”陷阱）。

#### 关键配置项（按领域分组）

**DeepSeek（LLM）**

- `DEEPSEEK_API_KEY`：必填；缺失会导致对话路径直接报错。
- `DEEPSEEK_BASE_URL`：默认 `https://api.deepseek.com`，用于私有化/代理场景。
- `DEEPSEEK_MODEL` / `DEEPSEEK_REASONER_MODEL`：普通对话与 `/deep` 的模型选择。
- `DEEPSEEK_TEMPERATURE` / `DEEPSEEK_MAX_TOKENS`：影响输出风格与成本。
- `DEEPSEEK_TIMEOUT_MS`：LLM 调用超时，过小会导致频繁失败。
- `DEEPSEEK_FORCE_PLAIN` + `SYSTEM_PROMPT`：共同决定输出格式约束（见第 7 节陷阱）。

**OneBot / NapCat**

- `ONEBOT_WS_URL`：Bot 作为 WS 客户端连接的地址（Compose 内默认 `ws://napcat:3001`）。
- `ONEBOT_ACCESS_TOKEN`：若 NapCat 配置了 token，需要填写；本项目用 `Authorization: Bearer <token>` 发送。
- `BOT_SELF_ID`：用于识别“消息是否 @ 了机器人”与“过滤自发消息”；不设时会回退到 event 的 `self_id`。
- `ONEBOT_RECONNECT_MS`：断线重连间隔。

**权限与风控**

- `ADMIN_IDS`：管理员 id 列表（逗号分隔）。
- `WHITELIST_MODE`：true 时只允许白名单 + 管理员；false 时默认放行（黑名单仍可拦截）。
- `ALLOWLIST` / `DENYLIST`：名单“种子”（只在首次初始化 state 时写入，见陷阱）。
- `BLOCKED_PATTERNS`：逗号分隔的正则列表（用于敏感词/规则拦截）。
- `ALLOW_GROUP_PLAIN`：true 时群聊无需 @ 也会响应（风险更高）。

**会话与成本控制**

- `MAX_CONTEXT_MESSAGES`：对话时携带的最近消息条数。
- `SUMMARY_TRIGGER`：history 超过该阈值触发摘要压缩（属于成本/质量权衡点）。

**限流**

- `USER_RATE_LIMIT` / `GROUP_RATE_LIMIT` / `GLOBAL_RATE_LIMIT`：每分钟限额。

**观测**

- `PORT`：健康检查/状态端口。
- `LOG_PROMPTS` / `LOG_RESPONSES`：是否打印完整提示词与模型回复（生产环境慎开）。

#### 约定优于配置：不写在 README 但默认成立的假设

- **群聊默认必须 @**：否则直接忽略（除非 `ALLOW_GROUP_PLAIN=true`）。
- **OneBot message segments 必须是 array 格式**：否则无法识别 `@`，也会影响文本提取质量。
- **状态文件存在时，ALLOWLIST/DENYLIST 种子不再生效**：名单更新优先通过命令或直接编辑 `data/state.json`。
- **会话上下文不落盘**：重启后上下文清零（这是设计选择，不是 bug）。

---

### 7. 常见误区与理解陷阱

这一节专门告诉你：哪些地方“看起来像写错了”，但实际是运行时/协议/约束导致的；以及哪些点最容易造成“怎么不回消息”的故障。

#### 1) NapCat 的 WS 模式搞反：正向 vs 反向

- 本项目是 **OneBot WS 客户端**，会去连 `ONEBOT_WS_URL`。
- 因此 NapCat 必须提供 **WS 服务端**（监听 3001）；如果你把 NapCat 配成“反向 WS 客户端”，它会试图去连一个并不存在的 Bot WS Server，最终表现为“Bot 永远收不到消息”。

#### 2) `messagePostFormat` 不是细节：决定能否识别 @

- 本项目的 “群聊必须 @ 触发” 依赖 segments 里 `type: 'at'`。
- 如果 NapCat 发的是纯字符串消息（segments 为空），机器人会认为“没有 @”，从而在群聊里**永远不响应**。

#### 3) `ALLOWLIST` / `DENYLIST` 只像“初始化参数”，不是“实时配置”

- 持久化状态以 `data/state.json` 为准；当该文件存在且可解析时，启动不会再合并 ALLOWLIST/DENYLIST 种子。
- 这常见于“我改了 .env 怎么没生效”：需要通过命令 `/allow` `/deny`，或删除/修正 `data/state.json` 后重启。

#### 4) 上下文、限流、锁都是内存态：重启即丢

- 这不是 bug，而是“轻量核心”的取舍：避免引入数据库/缓存。
- 结果是：重启后上下文清零、限流桶清零、处理队列清零；但白/黑名单与用量会保留。

#### 5) 摘要压缩策略是“成本优先”的近似方案

- 触发摘要后会裁剪 history，并把摘要作为 system message 注入。
- 这类实现容易出现：摘要与最近消息重复、或对更早信息覆盖不足。修改前先明确你要优化的是成本、连贯性还是可控性。

#### 6) “纯文本模式”与提示词约束要谨慎

- `DEEPSEEK_FORCE_PLAIN=true` 会强化“不要使用 Markdown”等格式约束，但模型并不总能稳定遵循。
- 如果你要做“严格结构化输出”，仅靠 prompt 往往不够，需要在发送前做格式化/过滤/分段策略。

#### 7) 不要轻易移除会话锁与三层限流

- 看起来像“多余的防御代码”，但在群聊高并发时它们是稳定性底座：
    - 无锁：同一会话并发会乱序，history 污染，最终输出不可预测。
    - 无限流：外部 API 易被刷爆，整体故障变成“所有人都用不了”。

---

### 8. 如何继续深入理解或二次开发

#### 推荐的理解顺序（从哪里读起）

1. `README.md`：了解部署形态与功能清单。
2. `src/index.ts`：抓住“依赖装配 + 消息流水线”这条主干。
3. `src/onebot.ts`：理解外部事件如何映射成内部 `ParsedMessage`，以及如何发消息。
4. `src/conversation.ts`：理解上下文、摘要、persona、deep 模式如何组合成 prompt。
5. `src/deepseek.ts`：理解 LLM 调用模型、错误/超时行为。
6. `src/store.ts`：理解哪些状态会落盘、哪些不会；权限与静音的语义。
7. `src/commands.ts`：扩展命令的主要入口。
8. `src/config.ts` / `src/types.ts`：补齐配置项与类型边界。

#### 扩展功能时应遵循的原则（避免把轻量核心写成“半个框架”）

- **保持边界清晰**：
    - OneBot 解析与发送只放在 `OneBotClient`。
    - LLM 供应商差异只放在 `ILLMClient` 实现里。
    - 业务策略（权限/限流/风控/分流）集中在入口流水线。
- **先加策略，再加能力**：任何“更聪明的回复”都应先考虑风控与稳定性（限流、并发、失败提示）。
- **默认可观测**：新增关键路径建议配合 `/status` 暴露指标或至少打印结构化日志（注意隐私与密钥）。

#### “稳定核心” vs “可替换层”（建议保持不动/可以自由替换的部分）

- **稳定核心（不建议随意改动）**
    - 消息处理流水线的顺序：静音 → 群聊触发 → 权限 → 拦截 → 命令/对话 → 限流 → 锁 → LLM → 发送
    - 会话 key 规则（群/私聊隔离）
    - OneBot 事件解析与动作发送的最小集合
- **可替换层（扩展点）**
    - `ILLMClient`：接入别的模型、加流式输出、加重试/熔断
    - `IStore`：接入 Redis/SQLite/Postgres，持久化会话上下文或分布式限流
    - 命令系统：新增 `/tool` `/kb` 等业务能力
    - 风控：更丰富的内容审核、分级权限、群维度配置

#### 排查问题的切入点（实战导向）

- **“不回消息”**：
    - 先看 NapCat 是否正常登录、OneBot WS server 是否开启、token 是否一致。
    - 群聊是否 @ 了机器人；`ALLOW_GROUP_PLAIN` 是否为 false 且 segments 是否为 array。
    - 用户是否被黑名单或未在白名单模式下放行。
- **“一直提示限流/系统繁忙”**：
    - 检查 `USER_RATE_LIMIT/GROUP_RATE_LIMIT/GLOBAL_RATE_LIMIT` 是否过低。
    - 检查是否存在外部群聊刷屏导致全局被打满。
- **“回答质量差/上下文断裂”**：
    - 调整 `MAX_CONTEXT_MESSAGES` 与 `SUMMARY_TRIGGER` 的权衡。
    - 检查是否频繁触发摘要导致关键信息被压缩丢失。
- **“DeepSeek 调用失败”**：
    - 检查 `DEEPSEEK_API_KEY`、网络、`DEEPSEEK_BASE_URL`、超时参数。
    - 打开 `LOG_PROMPTS/LOG_RESPONSES` 前先评估隐私与成本。
