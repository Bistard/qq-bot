# 渐进式重构计划（减少 index.ts 体积，保持高内聚/低耦合）

## 目标
- 在不大改行为的前提下，逐步把 `index.ts` 拆成少量清晰模块。
- 先拆最重/最独立的部分，避免过早创建过多目录。
- 为后续测试铺路：拆出的模块暴露接口，便于 mock。

## 拆分步骤（推荐顺序）
1) **config 与类型**  
   - 新建 `src/config.ts`：负责 env 解析，导出 `loadConfig` 和 `BotConfig` 类型。  
   - 新建 `src/types.ts`：放通用类型（ChatMessage、Usage、OneBot 事件/消息结构等），供各模块复用。

2) **日志与工具类**  
   - 新建 `src/logger.ts`：当前 Logger 抽出，保留 scope 能力。
   - 新建 `src/utils.ts`：通用函数（parseList/parsePatterns/toNumber/chunkMessage 等）。

3) **基础设施类**  
   - 新建 `src/store.ts`：持久化 store 类（白/黑名单、静音、用量）。暴露接口 `IStore` + 文件实现。
   - 新建 `src/limiter.ts`：RateLimiter 抽出，导出接口 `IRateLimiter` + 简单实现。
   - 新建 `src/lock.ts`：LockManager 抽出，保持 API 不变。

4) **外部服务**  
   - 新建 `src/deepseek.ts`：DeepseekClient 抽出，导出接口 `ILLMClient`。保留超时/错误处理。
   - 新建 `src/onebot.ts`：OneBotClient 抽出，包含 WS 连接、重连、消息解析、发送。

5) **业务核心**  
   - 新建 `src/conversation.ts`：ConversationManager 抽出，依赖 `ILLMClient`、`IStore`、配置。
   - 新建 `src/commands.ts`：命令注册与处理，接收上下文对象（config/store/conversations/logger）。

6) **启动与组合**  
   - 保留 `src/index.ts` 仅做装配：加载配置 → 实例化 logger/store/limiter/llm/onebot/conversation/commands → 注册事件 → 启动健康检查。

7) **测试准备（轻量）**  
   - 选一个测试框架（推荐 Vitest）；新增 `npm test`。  
   - 首批单测：`limiter`、`store`、`conversation`（使用 mock LLM）、`commands`（mock store/conversation）。  
   - Mock：简单内存版 OneBot（事件 emitter）、LLM（返回固定文本）、Store（内存实现），随着拆分推进补充。

## 原则
- 每一步拆分后保证 `npm run build` 通过，运行行为不变。
- 控制目录深度，优先平铺到 `src/`，后续如有需要再分子目录。
- 接口优先：模块之间通过接口交互，便于后续替换实现或单测 mock。

## 完成标准
- `index.ts` 明显瘦身（仅装配/启动逻辑）。
- 核心模块（config/logger/store/limiter/llm/onebot/conversation/commands）各自独立且可单测。
- 新增 `npm test` 可跑通首批基础单测。***
