# SQLite & 记忆系统：数据库重构设计（面向未来功能）

本文档基于当前代码库的实际实现（`src/store.ts`、`src/conversation.ts`、`src/index.ts`、`src/onebot.ts`）与“未来功能清单”给出：**SQLite 是否够用、需要提前考虑的坑、推荐的数据库/代码结构、以及从现有 JSON/内存态迁移的路径**。目标是打好“长期记忆 + 可搜索历史 + 可扩展工具/主动行为”的地基，同时保持可回滚与可运维。

> 本版本先按“只储存文字”设计：**不下载/不落盘图片与附件、不在 DB 中设计多媒体实体表**；链接/新闻等仅保存文本（URL/标题/正文/摘要）。

---

## 1. 结论：4 人小群 + 1 Bot，SQLite 够用吗？

结论：**够用，而且很合适**（前提：单机单实例、数据目录是本机磁盘卷，不是 NFS 共享卷）。

原因：

- 4 人群即使“全量记录消息 + FTS 搜索”，数据规模也远小于 SQLite 能轻松承受的量级（百万行级别也没问题）。
- 你的瓶颈更可能来自：LLM 调用成本、网页抓取带宽、以及“分析任务”占用时间，而不是数据库吞吐。
- SQLite 的运维成本最低：单文件挂卷 + 备份复制即可。

什么时候 SQLite 会开始不够舒服（不是现在）：

- 多群/高并发（多个容器/多进程同时写同一个 DB 文件）
- 需要复杂的权限审计、分库分表、分布式任务队列、跨实例一致性限流/锁
- 需要高质量向量检索（embedding）并且规模大到 FTS + 规则不够用

这些场景下再迁移到 Postgres（+ Redis）更合适；本设计会让迁移可控。

---

## 2. 现状盘点：现在项目怎么存、缺了什么

### 2.1 已持久化（跨重启保留）

当前持久化只有一个 JSON 文件（`src/store.ts`）：

- `${DATA_DIR}/state.json`：白名单、黑名单、静音频道、累计用量
- 写入方式：每次变更整文件覆盖写回

### 2.2 未持久化（重启即丢）

- 会话短期记忆（history）、会话摘要（summary）、会话 persona：`ConversationManager` 内存 `Map`（`src/conversation.ts`）
- 限流桶与锁：都在内存（`src/index.ts`）

这与你的目标功能冲突点：

- “长期记忆/摘要/画像”必须可查询、可更新、可审计；只靠内存 Map 做不到
- “全量消息记录 + 搜索”必须是 append-only 的结构化存储；JSON 不合适

---

## 3. 未来功能带来的数据与查询模式（先把问题讲清楚）

把你的功能按数据形态拆开，会更容易设计：

### A. 原始事实流（append-only，基本不改）

- 群/私聊消息文本（plainText、时间戳、message_id、user/group/channel 等元信息）
- 外部抓取的文本内容（知乎热榜、网页正文/摘要、通报文本）
- Bot 自己发出的消息记录（便于“像人一样”的行为审计）

典型查询：

- “最近 20 条消息”（短期记忆）
- “过去一周某关键词出现了几次 / 谁说的”
- “按用户/时间范围导出消息”

### B. 派生/可变数据（会被更新覆盖）

- 会话摘要（长期记忆/压缩）
- 用户画像（随时间更新）
- facts（客观事实）：可由管理员写入，也可由模型提取后再确认
- 内容理解结果：链接摘要、网页摘要、新闻摘要等文本产物

典型查询：

- “给 LLM 构造 prompt：取会话摘要 + 最近 N 条 + 与用户相关的 facts”
- “用户画像：过去 30 天兴趣点/情绪趋势”

### C. 自动化与主动行为（需要调度/幂等/冷却）

- 定时抓新闻：上午/晚上
- 日历提醒：T-30天/T-7天/T-1天
- 主动破冰：需要 quiet hours、冷却、预算与策略

典型查询：

- “下一次要执行的任务是什么”
- “某频道上一次主动发言是什么时候（避免打扰）”

---

## 4. 需要提前考虑的坑（比表结构更重要）

### 4.1 Docker 镜像与 SQLite 驱动（你现在是 `node:20-alpine`）

当前 `Dockerfile` 使用 `node:20-alpine`。多数 SQLite 驱动是原生模块，alpine（musl）下更容易踩编译/兼容坑。

建议二选一：

- **更稳**：把运行时镜像改为 `node:20-slim`（Debian），然后选 `better-sqlite3` 或 `sqlite3` 都更顺。
- **继续 alpine**：需要在构建阶段装 toolchain 并确保生产阶段能装好原生依赖（维护成本更高）。

### 4.2 一致性与并发（WAL + busy_timeout）

建议默认启用：

- `PRAGMA journal_mode=WAL;`
- `PRAGMA synchronous=NORMAL;`
- `PRAGMA busy_timeout=5000;`

并保持“单进程单连接”即可（你这个群规模足够）。

### 4.3 隐私合规：全量记录聊天是“高风险能力”

你计划“完全记录群消息 + 可检索”，这会把项目从“聊天机器人”变成“聊天归档系统”。建议从地基层就支持：

- 可配置开关：是否记录原文、是否记录外链正文（本阶段不记录/不持久化多媒体）
- retention（保留期）：比如默认只保留 90 天，或按命令/配置持久化
- 最低限度的“删除能力”：按用户/按时间范围删除，或“忘记我”
- 可选“脱敏/裁剪”：只存 plainText、去除 CQ/段落、或只存摘要

### 4.4 数据膨胀：长文本不要无上限塞进 DB

最佳实践：

- DB 存：来源 URL、标题、摘要、正文（可截断）、索引键（FTS）
- 对“网页正文”建议：只保留摘要或限制最大长度，避免 DB 无限膨胀

这样备份/清理/迁移都更可控。

### 4.5 “主动行为”要从底层就能控力度

需要在 DB 层就有“冷却、预算、静默时段、允许范围”的可配置数据结构，否则以后只能在 prompt 里硬控，容易用力过猛。

---

## 5. 数据库总体策略（“一个 SQLite”如何承载全部能力）

### 5.1 一个 DB 文件 + 明确分层

建议第 1 版就用一个文件（如 `data/bot.db`），但**逻辑上分层**：

- `state_*`：权限/静音/用量等“系统状态”
- `msg_*`：消息归档与搜索
- `mem_*`：会话摘要、短期记忆游标
- `user_*`：画像与用户事实
- `doc_*`：外部文本（网页/新闻）的抓取与摘要结果
- `job_*`：任务队列与调度

未来如果日志爆炸，再把 `msg_*` 拆到第二个 DB（`history.db`）即可；业务层不变。

### 5.2 Schema 版本与迁移

必须具备：

- `migrations` 表或 `PRAGMA user_version`
- 启动时自动执行迁移（幂等）
- “首次启用 SQLite 自动导入 `state.json`”（也要幂等）

### 5.3 搜索能力：优先 FTS5（关键词检索）

对于“群聊历史检索”，FTS5 是性价比最高的底座：

- `msg_messages` 存储原始消息
- `msg_messages_fts` 用 FTS5 存储可搜索字段（plainText/用户昵称等）
- 用触发器或应用层双写保持一致（小规模建议应用层双写，避免 trigger 复杂）

向量检索（embedding）可以后置（需要时再加）。

---

## 6. 推荐 Schema（面向你的功能清单）

> 类型约定：时间统一 `INTEGER`（Unix ms），ID 用 `TEXT`（OneBot 的 id 混合 number/string，避免坑）。

### 6.1 迁移与元信息

```sql
CREATE TABLE IF NOT EXISTS meta_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

### 6.2 系统状态（迁移当前 `state.json`）

```sql
-- allow/deny（互斥）
CREATE TABLE IF NOT EXISTS state_acl (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('allow', 'deny')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_state_acl_status ON state_acl(status);

CREATE TABLE IF NOT EXISTS state_muted_channels (
  channel_key TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS state_usage_total (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  messages INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 6.3 会话记忆（摘要 + persona + “短期记忆游标”）

```sql
CREATE TABLE IF NOT EXISTS mem_sessions (
  session_key TEXT PRIMARY KEY,
  persona TEXT,
  summary TEXT,
  summary_updated_at INTEGER,
  last_message_ts INTEGER, -- 最近消息时间（用于主动行为判断）
  updated_at INTEGER NOT NULL
);

-- 可选：摘要历史（便于回滚/审计）
CREATE TABLE IF NOT EXISTS mem_session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_summary_session_time ON mem_session_summaries(session_key, created_at);
```

“最近 20 条消息”不需要单独存：直接从 `msg_messages` 按时间倒序取 `LIMIT 20` 即可。

### 6.4 消息归档与搜索（对应功能 10）

```sql
CREATE TABLE IF NOT EXISTS msg_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'onebot',
  channel_key TEXT NOT NULL,        -- onebot:group:<gid> / onebot:dm:<uid>
  user_id TEXT NOT NULL,
  group_id TEXT,
  message_id TEXT,                  -- OneBot message_id
  ts INTEGER NOT NULL,              -- 事件时间（ms）
  plain_text TEXT NOT NULL,         -- 用于检索/摘要/短期记忆
  is_bot INTEGER NOT NULL DEFAULT 0 -- 机器人自己发的消息也可以记录
);
CREATE INDEX IF NOT EXISTS idx_msg_channel_ts ON msg_messages(channel_key, ts);
CREATE INDEX IF NOT EXISTS idx_msg_user_ts ON msg_messages(user_id, ts);

-- FTS5（关键词检索）
CREATE VIRTUAL TABLE IF NOT EXISTS msg_messages_fts USING fts5(
  plain_text,
  user_id,
  channel_key,
  content='msg_messages',
  content_rowid='id'
);
```

同步策略建议：

- 小规模先用应用层双写：插入 `msg_messages` 后，插入/更新 `msg_messages_fts`。
- 以后再考虑 trigger 自动同步。

### 6.5 外部文本（网页/链接，仅存文字）

本阶段不做多媒体持久化；对链接/网页/联网获取的内容，只保存文本结果（URL/标题/正文/摘要），用于二次引用与搜索。

```sql
CREATE TABLE IF NOT EXISTS doc_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  content_text TEXT,           -- 可为空；建议限制长度或只存摘要
  unique_key TEXT NOT NULL,    -- 用于去重（如 sha256(url)）
  UNIQUE (unique_key)
);
CREATE INDEX IF NOT EXISTS idx_doc_pages_time ON doc_pages(fetched_at);
```

### 6.6 Facts（客观事实）与用户画像（对应功能 1/4）

事实建议分两类：

- “确定事实”：由管理员写入或用户明确确认（confidence 高）
- “推断画像”：模型推断（confidence 低、可衰减、可被覆盖）

```sql
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  profile_json TEXT NOT NULL       -- 画像快照（偏好/风格/禁忌/话题等）
);

-- 事实库：scope 支持 global/user/group/channel
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'user', 'group', 'channel')),
  scope_id TEXT,                   -- global 为 NULL，否则为 userId/groupId/channelKey
  kind TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact', 'preference', 'constraint', 'profile_inference')),
  fact_key TEXT,                   -- 可用于“同类覆盖”（如 timezone、likes:xxx）
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'manual', -- manual/llm/import
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(scope_type, scope_id, fact_key);
```

（可选但强烈建议）保留“画像/事实变更日志”，方便纠错：

```sql
CREATE TABLE IF NOT EXISTS user_profile_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL,              -- 'fact_add'/'fact_update'/'profile_update'/'manual_override'
  json_patch TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_events_user_time ON user_profile_events(user_id, created_at);
```

### 6.7 自动化/主动行为/日历（对应功能 5/6/11）

这里建议用“任务队列 + 定时扫描”的最小实现：单容器也能跑，未来可拆 worker。

```sql
-- 任务队列（通用）：抓新闻、跑分析、发提醒、跑摘要更新等都可以用
CREATE TABLE IF NOT EXISTS job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,          -- 'news_fetch'/'analyze_message'/'send_reminder'/...
  status TEXT NOT NULL,        -- 'queued'/'running'/'done'/'error'
  run_at INTEGER NOT NULL,     -- 计划执行时间
  locked_at INTEGER,
  locked_by TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_run_at ON job_queue(status, run_at);

-- 主动行为的“力度控制”（每个频道/用户一个策略）
CREATE TABLE IF NOT EXISTS proactive_policy (
  target_type TEXT NOT NULL CHECK (target_type IN ('channel', 'user')),
  target_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  quiet_hours_json TEXT,       -- 如 {"start":"23:00","end":"08:00","tz":"Asia/Shanghai"}
  cooldown_seconds INTEGER NOT NULL DEFAULT 3600,
  daily_budget INTEGER NOT NULL DEFAULT 2,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id)
);

-- 主动发言记录（用于冷却/审计）
CREATE TABLE IF NOT EXISTS proactive_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,        -- 'icebreak'/'followup'/'news_digest' 等
  text TEXT NOT NULL,
  status TEXT NOT NULL         -- 'sent'/'skipped'/'error'
);
CREATE INDEX IF NOT EXISTS idx_proactive_target_time ON proactive_events(target_type, target_id, created_at);

-- 日历事件与提醒
CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'group', 'channel')),
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_ts INTEGER NOT NULL,
  tz TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  recurrence_json TEXT,        -- 可选：RRULE 或自定义
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_owner_start ON calendar_events(owner_type, owner_id, start_ts);

CREATE TABLE IF NOT EXISTS calendar_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  offset_seconds INTEGER NOT NULL, -- 提前多久提醒：30天/7天/1天
  next_run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_next ON calendar_reminders(next_run_at);
```

### 6.8 新闻抓取（对应功能 6）

```sql
CREATE TABLE IF NOT EXISTS news_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,          -- 'zhihu'
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  fetch_cron TEXT,             -- '0 9 * * *' 之类（如果你打算引入 cron）
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  published_at INTEGER,
  fetched_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  summary TEXT,
  content_text TEXT,
  unique_key TEXT NOT NULL,    -- 用于去重（如 sha256(url)）
  UNIQUE (source_id, unique_key)
);
CREATE INDEX IF NOT EXISTS idx_news_source_time ON news_items(source_id, fetched_at);
```

---

## 7. 代码层如何设计（保证未来可拓展、可迁移）

### 7.1 不要把所有能力继续塞进一个 `IStore`

当前 `IStore`（`src/store.ts`）适合“系统状态”，但未来会变成万能对象。建议分层接口：

- `StateStore`：ACL/静音/用量（现有功能迁移）
- `MessageStore`：写入/查询消息、FTS 搜索（功能 3/10 的底座）
- `SessionStore`：session 的 summary/persona/last_seen（功能 2/5）
- `DocumentStore`：网页/新闻文本与摘要（功能 6/9/10 的底座）
- `FactsStore`：facts CRUD 与检索（功能 1/4）
- `ProfileStore`：画像快照 + events（功能 4）
- `JobStore`：任务队列（功能 5/6/11 的底座）

上层只依赖这些接口，底层可切 SQLite/Postgres。

### 7.2 写入路径要“先落原始，再做派生”（事件溯源思路）

推荐主链路：

1. 收到 OneBot message → 立刻落 `msg_messages`（可配置开关）
2. 快速处理回复（LLM）
3. 把重活（画像分析/网页抽取/摘要更新）塞进 `job_queue`
4. worker（同进程也行）异步消费 job，更新 `facts/user_profiles/mem_sessions/doc_pages`

这样可以保证响应快、可恢复、可追溯。

### 7.3 配置建议（把“合规/打扰控制/成本控制”变成显式配置）

建议新增（示意）：

- `STORAGE_DRIVER=sqlite|json`（过渡期）
- `SQLITE_PATH=/app/data/bot.db`
- `LOG_CHAT_HISTORY=true|false`
- `RETENTION_DAYS_MESSAGES=90`（默认保留期）
- `ENABLE_PROACTIVE=false|true`（总开关）
- `NEWS_FETCH_SCHEDULE=...` / `NEWS_TARGET_CHANNEL=...`
- `ALLOW_WEB_BROWSE=false|true` + `WEB_ALLOWLIST_DOMAINS=...`

---

## 8. 从现有功能迁移：最稳的落地顺序

### Phase 1：把 `state.json` 迁到 SQLite（零体验变化）

迁移内容：ACL/静音/用量（对应 `src/store.ts` 的全部功能）。

上线要求：

- SQLite schema + migration
- 首次启用 SQLite：自动导入 `data/state.json`（幂等）
- 保留 JSON store 作为 fallback（可回滚）

### Phase 2：会话摘要/persona 持久化（体验显著提升）

迁移内容：

- `ConversationManager` 的 `state.summary/state.persona` 写入 `mem_sessions`
- 重启后能恢复会话摘要与默认 persona（“长期记忆”雏形）

### Phase 3：消息归档 + 搜索（为功能 3/10 打底）

实现内容：

- 记录所有消息（或按配置/权限记录）
- 支持 `LIMIT 20` 取短期记忆
- FTS5 关键词检索 + 指令接口（例如 `/search <kw> [days]`）

### Phase 4：facts/画像/内容理解（为 1/4/7/8/9 打底）

实现内容：

- `facts` + `user_profiles` + `doc_pages/news_items`
- 引入 `job_queue`，把分析从主链路解耦

### Phase 5：主动行为/新闻/日历（为 5/6/11 打底）

实现内容：

- `proactive_policy`、`job_queue` 定时扫描
- 新闻抓取入库、生成摘要通报并记录
- 日历事件与提醒的生成、执行与去重

---

## 9. 运维与备份（SQLite 项目成败的关键）

- DB 文件位置建议：`./data/bot.db`（Compose 已挂卷 `./data:/app/data`）
- 启用 WAL 时备份：
    - 推荐使用 `VACUUM INTO 'backup.db'` 生成一致快照，再复制 `backup.db`
    - 或停机复制 `bot.db` + `bot.db-wal` + `bot.db-shm`
- 定期清理：
    - 消息保留期到期删除
    - 大文本（网页正文）可按需保留或只留摘要
