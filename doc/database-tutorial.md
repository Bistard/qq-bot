# SQLite 保姆教程（本项目专用）

你不需要“学会数据库”才能用好它。本教程的目标是：让你能 **看懂这个项目的 SQLite 里存了什么、如何验证机器人确实在写库、如何用命令查数据、如何备份/恢复、遇到问题怎么排查**。

> 本项目当前只存文字：消息 `plain_text`、会话摘要、白/黑名单、静音、用量统计，以及用于搜索的 FTS 索引。

---

## 0. 你需要知道的 4 个概念（超重要）

1. **SQLite 就是一个文件**  
   默认在 `./data/bot.db`（宿主机路径）。Docker 会把 `./data` 挂载进容器 `/app/data`。

2. **WAL 模式会产生 `-wal`/`-shm` 两个文件**  
   你可能会看到：
    - `data/bot.db`
    - `data/bot.db-wal`
    - `data/bot.db-shm`
      这是正常的，不要手动删（尤其是机器人运行时）。

3. **“表”就是分类存储的结构**  
   例如：`state_acl` 存白/黑名单，`msg_messages` 存聊天文本，`mem_sessions` 存会话摘要。

4. **FTS5 是“全文搜索索引”**  
   机器人能 `/search`，靠的是 `msg_messages_fts`（虚拟表）来做关键词搜索。

---

## 1. 启用 SQLite（确认你现在就是 SQLite 模式）

### 1.1 检查 `.env`

确保你在 `.env`（不是 `.env.example`）里有类似配置：

```bash
STORAGE_DRIVER=sqlite
SQLITE_PATH=/app/data/bot.db
LOG_CHAT_HISTORY=true
DATA_DIR=/app/data
```

说明：

- `STORAGE_DRIVER=sqlite`：启用 SQLite；否则默认 `json`（写 `data/state.json`）。
- `SQLITE_PATH`：容器内 DB 文件路径；你一般不用改。
- `LOG_CHAT_HISTORY=true`：启用“消息存档 + 搜索”。关掉后 `/search` 会提示未开启。

### 1.2 启动后看日志确认

启动机器人后，你应该能在日志里看到类似：

- `SQLite 已打开: .../bot.db`
- `已应用数据库迁移: 001_init_state`（首次启动才会出现）
- `已从 state.json 导入数据到 SQLite`（如果你以前用过 JSON 且 DB 为空）

---

## 2. DB 文件到底在哪？（宿主机 vs 容器）

### 2.1 Docker Compose 默认挂载

`docker-compose.yml` 里 bot 服务有：

- `./data:/app/data`

所以：

- 容器内：`/app/data/bot.db`
- 宿主机：`./data/bot.db`

你想“用 sqlite3 打开数据库”，通常在宿主机直接打开 `data/bot.db` 就行。

---

## 3. 安装 `sqlite3` 命令行工具（推荐做法）

你需要一个能运行 `sqlite3` 的环境。最简单就是在宿主机安装。

### 3.1 Ubuntu / Debian

```bash
sudo apt-get update
sudo apt-get install -y sqlite3
```

### 3.2 CentOS / RHEL

```bash
sudo yum install -y sqlite
```

### 3.3 Alpine

```bash
sudo apk add sqlite
```

### 3.4 Windows（推荐 WSL）

你当前路径像 `/mnt/d/...`，说明你可能在 WSL 里开发；那就直接按 Ubuntu/Debian 的方式装即可。

---

## 4. 打开数据库（最常用的交互方式）

在项目根目录（有 `docker-compose.yml` 的目录）执行：

```bash
sqlite3 data/bot.db
```

你会进入 sqlite 交互界面，看到提示符：

```text
sqlite>
```

建议先输入这几个“辅助显示”命令（只影响显示格式）：

```sql
.headers on
.mode column
.nullvalue NULL
```

退出：

```sql
.quit
```

---

## 5. 先看“有什么表”（理解数据库结构）

在 sqlite3 里输入：

```sql
.tables
```

你应该能看到类似（表名可能顺序不同）：

- `meta_migrations`
- `state_acl`
- `state_muted_channels`
- `state_usage_total`
- `mem_sessions`
- `mem_session_summaries`
- `msg_messages`
- `msg_messages_fts`

看某个表的建表语句：

```sql
.schema msg_messages
```

---

## 6. 每张表存什么？（按“你能用到的功能”讲）

### 6.1 `meta_migrations`：迁移记录（别动）

机器人启动时会自动建表/升级 schema；每次升级会写一条迁移记录在这里。

查看：

```sql
SELECT * FROM meta_migrations ORDER BY applied_at;
```

### 6.2 `state_*`：系统状态（Phase 1）

#### `state_acl`：白/黑名单

查看当前 allow/deny：

```sql
SELECT user_id, status, datetime(updated_at/1000,'unixepoch','localtime') AS updated
FROM state_acl
ORDER BY user_id;
```

#### `state_muted_channels`：静音频道

```sql
SELECT channel_key, datetime(updated_at/1000,'unixepoch','localtime') AS updated
FROM state_muted_channels
ORDER BY channel_key;
```

#### `state_usage_total`：累计用量

```sql
SELECT messages, prompt_tokens, completion_tokens,
       datetime(updated_at/1000,'unixepoch','localtime') AS updated
FROM state_usage_total
WHERE id = 1;
```

### 6.3 `mem_*`：会话摘要 / persona（Phase 2）

#### `mem_sessions`：每个会话的摘要与 persona

- `session_key` 规则和代码一致：
    - 群：`onebot:group:<groupId>`
    - 私聊：`onebot:dm:<userId>`

查看最近更新的会话摘要：

```sql
SELECT session_key,
       substr(summary, 1, 80) AS summary_preview,
       persona,
       datetime(updated_at/1000,'unixepoch','localtime') AS updated
FROM mem_sessions
ORDER BY updated_at DESC
LIMIT 20;
```

#### `mem_session_summaries`：摘要历史（可选审计）

```sql
SELECT session_key,
       datetime(created_at/1000,'unixepoch','localtime') AS created,
       substr(summary, 1, 80) AS summary_preview
FROM mem_session_summaries
ORDER BY id DESC
LIMIT 20;
```

### 6.4 `msg_*`：消息归档与搜索（Phase 3）

#### `msg_messages`：聊天文本日志

看最近 20 条消息（按时间倒序）：

```sql
SELECT datetime(ts/1000,'unixepoch','localtime') AS time,
       channel_key,
       user_id,
       plain_text
FROM msg_messages
ORDER BY ts DESC
LIMIT 20;
```

只看某个群的最近 20 条（把 `<gid>` 换成群号）：

```sql
SELECT datetime(ts/1000,'unixepoch','localtime') AS time,
       user_id,
       plain_text
FROM msg_messages
WHERE channel_key = 'onebot:group:<gid>'
ORDER BY ts DESC
LIMIT 20;
```

统计消息量：

```sql
SELECT COUNT(*) AS total FROM msg_messages;
```

#### `msg_messages_fts`：全文检索索引（FTS5）

`msg_messages` 是“原始消息表”（事实来源）；`msg_messages_fts` 是“全文搜索索引表”（为了让搜索更快）。  
你一般不直接读 `msg_messages_fts` 的内容，而是用它 `MATCH` 找到 rowid，再 `JOIN` 回 `msg_messages` 取出完整记录。

重要：**索引表不会自动替你“补齐历史”**。如果你之前已经把很多消息写进了 `msg_messages`，但当时程序没有同步写入 `msg_messages_fts`，那么：

- 直接 `LIKE` 查 `msg_messages` 会有结果
- 用 `MATCH` 查 `msg_messages_fts` 会没有结果（因为索引是空的/不完整）

最简单的搜索（关键词替换成你要搜的词）：

```sql
SELECT datetime(m.ts/1000,'unixepoch','localtime') AS time,
       m.channel_key,
       m.user_id,
       m.plain_text
FROM msg_messages_fts
JOIN msg_messages m ON m.id = msg_messages_fts.rowid
WHERE msg_messages_fts MATCH '关键词'
ORDER BY m.ts DESC
LIMIT 10;
```

如果你发现 `msg_messages` 有数据但 `MATCH` 没结果，可以重建 FTS 索引（不会改动原始消息）：

```sql
INSERT INTO msg_messages_fts(msg_messages_fts) VALUES('rebuild');
```

FTS 常用语法（只需记住这几个）：

- 单词：`'hello'`
- 多词：`'hello world'`（通常等价于 AND）
- 精确短语：`'"hello world"'`
- OR：`'hello OR world'`

---

## 7. “我怎么验证机器人真的在写库？”

最简单三步：

1. 开启 `LOG_CHAT_HISTORY=true`，并确保 `STORAGE_DRIVER=sqlite`
2. 在群里发几条消息，让机器人回复几次
3. 本地打开 sqlite3 执行：

```sql
SELECT COUNT(*) FROM msg_messages;
SELECT * FROM state_usage_total WHERE id=1;
SELECT COUNT(*) FROM mem_sessions;
```

如果 `msg_messages` 在增长、`state_usage_total` 的 messages/tokens 在增长、`mem_sessions` 有内容，就说明 Phase 1~3 都在工作。

补充：`mem_sessions` 只有在“生成过摘要”或你用过 `/persona` 改过人格时才一定会出现记录；如果你只是刚启动聊了几句，`mem_sessions` 可能还是 0（正常）。

---

## 8. `/search` 命令怎么用？（给“不会写 SQL”的你）

目前实现为管理员命令（需要你的 QQ 在 `ADMIN_IDS` 里）。

用法：

- `/search 关键词`
- `/search 关键词 20`（限制返回 20 条，最多 50）

注意：

- 必须 `LOG_CHAT_HISTORY=true`
- 目前返回内容会包含：时间、channelKey、userId、文本

---

## 9. 备份与恢复（最关键的运维操作）

### 9.1 推荐备份方式：`VACUUM INTO`

优点：生成一致快照，适合 WAL 模式，操作简单。

在项目根目录执行（会生成一个备份文件）：

```bash
sqlite3 data/bot.db "VACUUM INTO 'data/bot.backup.db';"
```

你也可以带时间戳：

```bash
sqlite3 data/bot.db "VACUUM INTO 'data/bot-$(date +%F).db';"
```

### 9.2 恢复方式

恢复就是“替换文件”：

1. 停止 bot（强烈建议）
2. 用备份文件覆盖 `data/bot.db`
3. 再启动 bot

注意：如果你用的是 WAL 模式，恢复时确保同目录里不要残留旧的 `bot.db-wal`/`bot.db-shm`（停机后一般会自动处理；不确定就一起删掉再启动）。

---

## 10. 常见问题（看这里就够了）

### Q1：我打开 `data/bot.db` 提示 “no such table”

原因通常是：机器人还没成功用 SQLite 启动（迁移没跑）。

排查：

- `.env` 是否 `STORAGE_DRIVER=sqlite`
- 日志里有没有 `SQLite 已打开`
- `SQLITE_PATH` 是否写错、`DATA_DIR` 是否挂载正确

### Q2：为什么有 `bot.db-wal` 和 `bot.db-shm`？

WAL 模式正常现象。不要手动删除（尤其运行时）。

### Q3：`/search` 没结果，但我确定发过这个词

检查：

- `LOG_CHAT_HISTORY=true` 吗？
- 你是不是在启用 SQLite 之前发的消息（旧消息不会自动补录）
- 看看 FTS 索引是否为空：`SELECT COUNT(*) FROM msg_messages_fts;`
- 如果 `msg_messages` 有数据但 `msg_messages_fts` 很少/为 0，执行：`INSERT INTO msg_messages_fts(msg_messages_fts) VALUES('rebuild');`
- 试试更简单的关键词（FTS 可能受分词/匹配规则影响；中文场景必要时用 `LIKE` 在 `msg_messages` 上做兜底查询）

### Q4：我能手动改数据库吗？

能，但不建议。你可以只做只读查询；写入/删除建议通过机器人命令或未来提供的管理脚本来做。  
如果你一定要改，建议先 `VACUUM INTO` 备份一份再动手。

---

## 11. 你下一步最推荐做什么？

如果你想熟悉数据库而不写一行代码，按这个顺序做：

1. 启动机器人（SQLite 模式 + 开启消息存档）
2. 群里随便聊几句
3. 在宿主机执行 `sqlite3 data/bot.db`
4. 依次跑：
    - `.tables`
    - `SELECT COUNT(*) FROM msg_messages;`
    - `SELECT * FROM state_usage_total WHERE id=1;`
    - `SELECT session_key, substr(summary,1,80) FROM mem_sessions LIMIT 5;`
5. 在群里试 `/search 关键词 10`

做到这一步，你就已经“会使用并理解这个项目的 SQLite”了。
