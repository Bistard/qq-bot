# 功能开发 Proposal：运行状态 / 成本监控 / 余额与告警

> 目标：通过指令快速获得 Bot 所在“部署环境 + 业务运行 + 成本”全景状态，并在风险出现时主动告警。

## 背景

当前项目已具备基础运维能力（`/status` 指令、`GET /healthz`、`GET /status` 等），但：

- `/status` 目前偏“业务计数”（活跃会话、累计对话、白/黑名单人数），缺少**宿主机/容器资源**与**版本/启动信息**。
- 仅有累计 tokens 统计（`/usage`），缺少**可审计的成本明细与汇总**（按天/按模型/按群/按用户等）。
- 无法查看 DeepSeek 账号侧的**剩余余额**，也缺少**低余额/高错误率/资源逼近**时的自动告警。

## 目标与范围

### In scope（本期包含）

1. **运行状态**：启动时间、运行时长、当前版本、CPU 使用率/负载、内存状态、硬盘剩余。
2. **AI 花费记录**：机器人将每次调用 DeepSeek 的 tokens、模型、估算费用等写入数据库。
3. **账号余额**：查询 DeepSeek API key 对应账号余额并展示（带缓存与失败降级）。
4. **成本视角增强（仅管理员）**：
   - 按天/按模型汇总
   - 最近 N 条明细
   - Top 消耗群/用户
   - 近 24h burn rate（消耗速度）与“预计还能撑几天”
5. **阈值提醒（带冷却）**：余额低、磁盘/内存逼近、DeepSeek 错误率飙升时，主动给管理员私聊/群里告警。

### Out of scope（暂不包含）

- DeepSeek 官方“消费流水/账单明细”拉取（目前公开 API 仅提供余额接口；消费明细需本项目自记录）。
- Prometheus/Grafana 全套监控体系（可作为后续扩展点）。
- 复杂的成本归因与财务对账（本期以“估算费用”为主）。

## 总体设计概览

### 命令/接口层

- 保持现有管理员指令 `/status`，增强输出；默认“简版”，增加参数获取“详细版”：
  - `/status`：一屏可读（核心状态 + 风险摘要）
  - `/status --full`：含成本汇总、Top、最近明细、DeepSeek 余额细节等（避免刷屏）
- 可选增加成本专用指令（看实现取舍，避免 `/status` 过重）：
  - `/cost`：近 24h / 今日 / 近 7 日汇总
  - `/cost recent [n]`：最近 n 条调用明细
  - `/cost top user|group [n] [range]`：Top 消耗归因

> 说明：`GET /status` 目前无鉴权，建议继续只暴露“非敏感”信息；涉及余额/归因明细建议仅走管理员指令，或为 HTTP 增加 token。

### 数据采集层

按三类采集：

1. **进程/运行时**：启动时间、uptime、Node 版本、进程内存、事件循环延迟（可选）等。
2. **系统资源**：CPU loadavg、CPU 使用率（系统或进程）、系统内存、磁盘使用情况（重点关注 `DATA_DIR` 分区）。
3. **DeepSeek & 成本**：
   - DeepSeek 余额：`GET /user/balance`（缓存）
   - 调用明细：每次 chat completion 的 `usage` + 模型 + 延迟 + 渠道（群/私聊）归因

## 运行状态：字段定义

建议 `/status`（简版）输出至少包含：

- **时间与版本**
  - 启动时间（ISO 或本地时间）
  - 运行时长（human readable）
  - 版本（`package.json` version + 可选 commit SHA）
- **CPU**
  - `loadavg(1/5/15)`（Linux/容器可用）
  - 进程 CPU 使用率（近 1s/5s 采样平均，或近一次采样差分）
- **内存**
  - 系统内存：total/used/free
  - 进程内存：RSS、heapUsed/heapTotal
- **磁盘**
  - `DATA_DIR` 所在文件系统：total/used/free（优先）
  - 若无法获取分区信息，至少给出 `DATA_DIR` 可写性与当前占用（目录大小可选）

实现建议：

- `os` 模块：`uptime()`、`loadavg()`、`totalmem()`、`freemem()`。
- 进程内存：`process.memoryUsage()`。
- CPU 使用率：`process.cpuUsage()` + 周期采样（更稳定）；或系统级 CPU 需要读取 `os.cpus()` times 差分。
- 磁盘空间：优先使用 Node `fs.statfs`（若运行环境支持）；否则 fallback 到 `df`（Linux 容器场景最常见）。

## DeepSeek 账号余额

### 能力边界

DeepSeek 提供余额查询接口：`GET /user/balance`（使用 `Authorization: Bearer <DEEPSEEK_API_KEY>`）。

> 公开文档未提供“近期消费流水”查询接口，因此消费明细需由本项目在调用时自记录。

### 设计要点

- **缓存**：默认 1–5 分钟（避免 `/status` 高频调用导致额外请求与失败放大）。
- **超时与降级**：余额请求失败时，`/status` 展示“余额不可用（原因简述）”，但不影响其他状态输出。
- **权限**：余额仅管理员可见；若将来加入 HTTP admin status，需要鉴权（token/内网）。

## 成本记录与估算

### 记录维度（每次 DeepSeek 调用）

建议写入字段：

- `ts`：时间戳
- `model`：使用的模型
- `prompt_tokens` / `completion_tokens` / `total_tokens`
- `latency_ms`：端到端耗时
- `channel_key`：群/私聊归因（例如 `onebot:group:<id>` / `onebot:dm:<id>`）
- `group_id`（可为空）与 `user_id`（发起者）
- `ok`：是否成功
- `error_code` / `error_type`（可选，便于错误率统计）
- `estimated_cost`：按定价表估算（单位建议以最小货币单位或 decimal string）
- `currency`：`CNY`/`USD`（与余额币种一致或可配置）

### 费用估算策略

- 基于 DeepSeek 定价表：按 `input_tokens` 与 `output_tokens` 分开计价（单位：每 1M tokens）。
- 价格随时间可能调整：需要在文档与代码中明确“估算费用”性质，并提供配置覆盖：
  - 方案 A：内置默认价格表（适配项目默认模型），允许通过 env 覆盖
  - 方案 B：全部通过 env 配置（更灵活，但配置复杂）

建议优先 **A**：先把默认模型（`DEEPSEEK_MODEL`、`DEEPSEEK_REASONER_MODEL`）覆盖好，并保留 override。

## 数据库存储设计

### SQLite（推荐，完整功能）

新增表（示例）：

- `llm_usage_log`
  - 主键 `id`（自增）
  - `ts`（整数毫秒）
  - `model`（text）
  - `prompt_tokens` / `completion_tokens` / `total_tokens`（integer）
  - `estimated_cost`（text 或 numeric）
  - `currency`（text）
  - `latency_ms`（integer）
  - `channel_key`（text）
  - `group_id`（text nullable）
  - `user_id`（text）
  - `ok`（integer 0/1）
  - `error`（text nullable，截断存储）

索引建议：

- `idx_llm_usage_ts`：按时间范围查询
- `idx_llm_usage_model_ts`：按模型 + 时间汇总
- `idx_llm_usage_group_ts`、`idx_llm_usage_user_ts`：Top 归因

### JSON/无 DB（降级）

若 `STORAGE_DRIVER=json`：

- 最低限度：继续维护现有累计 tokens，并增加“今日/近 24h”环形缓冲（内存）做 burn rate。
- 明细与 Top 归因能力可降级为“不可用/仅累计”，并在 `/status --full` 明示限制。

## 汇总与展示

### 汇总口径

- **最近 N 条明细**：按 `ts desc limit N`，展示 `ts + model + tokens + cost + channelKey + ok`。
- **按天汇总**：按本地时区或固定 UTC（需明确），建议按部署时区。
- **按模型汇总**：按 `model` 聚合 tokens/cost。
- **Top 群/用户**：在时间范围内按 `group_id` 或 `user_id` 聚合 cost 排序。
- **近 24h burn rate**：
  - `burn_24h = sum(cost where ts >= now-24h)`
  - `daily_rate = burn_24h`（或换算为每小时/每天）
  - `days_left = balance_total / daily_rate`（daily_rate=0 时显示 `∞/未知`）

### 输出格式建议（示意）

- `/status`（简版）：状态总览 + 风险摘要 + “使用 /status --full 查看明细”。
- `/status --full`：在简版基础上加：
  - DeepSeek 余额（总额/赠送/充值，币种）
  - 近 24h burn rate、预计可用天数
  - 今日/近 7 天 cost 汇总（可选）
  - Top 归因（Top 5 群/用户）
  - 最近 N 条调用明细（N=10 默认，可配置）

## 告警设计

### 触发条件（可配置）

- **余额低**：`total_balance < BALANCE_LOW_THRESHOLD`（按币种分别配置或仅支持一种币种）
- **磁盘逼近**：
  - `disk_free_bytes < DISK_FREE_BYTES_THRESHOLD` 或 `disk_free_percent < threshold`
- **内存逼近**：
  - 系统：`free_mem / total_mem < threshold`
  - 进程：`rss_bytes > threshold`（可选）
- **错误率飙升**：
  - 例如近 10 分钟 `error_rate = errors / total > threshold` 且 `total >= min_samples`

### 通知策略

- **目标**：管理员 DM（默认）+ 可选指定群（例如运维群）。
- **冷却时间**：每个告警类型独立 cooldown（例如 30–60 分钟），避免刷屏。
- **合并**：同类告警在 cooldown 内仅更新一次；若从“告警”恢复到“正常”，可选发送“恢复通知”（也带冷却）。

### 容错

- 告警发送失败不影响主流程；记录日志，等待下次周期重试。
- 当 DeepSeek 余额接口不可用时，不触发“余额低”告警（避免误报），但可触发“余额查询失败”告警（可选）。

## 配置项（建议新增/整理）

以下为建议（实际落地可裁剪）：

- `APP_VERSION`（可选）：覆盖显示的版本/commit（若不设置则用 `package.json` version）
- `STATUS_HTTP_TOKEN`（可选）：若要在 HTTP status 暴露敏感信息，用 token 保护
- `DEEPSEEK_BALANCE_CACHE_MS`：余额缓存时间（默认 300000）
- `DEEPSEEK_BALANCE_TIMEOUT_MS`：余额查询超时（默认 5000–10000）
- `COST_CURRENCY`：成本展示币种（默认 `CNY`，需与余额币种匹配）
- `COST_RECENT_N`：最近明细默认条数（默认 10）
- `ALERT_TARGETS`：告警目标（例如 `dm`、`group:123`，可逗号分隔）
- `ALERT_COOLDOWN_MS`：告警冷却（默认 3600000）
- `ALERT_BALANCE_LOW` / `ALERT_DISK_FREE_BYTES` / `ALERT_MEM_FREE_RATIO` / `ALERT_ERROR_RATE` 等阈值
- DeepSeek 定价 override（方案 A）：例如
  - `DEEPSEEK_PRICE_<MODEL>_IN_PER_1M`
  - `DEEPSEEK_PRICE_<MODEL>_OUT_PER_1M`

## 权限与安全

- `/status`、成本归因、DeepSeek 余额：**仅管理员可用**（复用现有 `ADMIN_IDS`）。
- 避免在任何输出中泄露：
  - API key（绝不输出）
  - 公网 IP、敏感路径（除非明确需要）
- 若扩展 HTTP endpoint 展示敏感信息，必须加 token 或只监听 localhost / 内网。

## 实施计划（里程碑）

1. **状态采集**：启动时间/版本/CPU/内存/磁盘采集模块 + `/status` 简版输出。
2. **成本日志落库**：在 DeepSeek 调用处记录 tokens/模型/延迟/归因/ok/error；SQLite schema & migration。
3. **成本汇总展示**：按天/按模型/Top/最近 N + burn rate + days left；`/status --full` 或 `/cost`。
4. **余额查询**：`GET /user/balance` 客户端 + 缓存/超时/降级。
5. **告警**：周期任务 + 阈值判定 + 冷却 + 发送到管理员。
6. **文档与验收**：补全 `.env.example`、README 指令说明、验收 checklist。

## 验收标准（建议）

- `/status` 能稳定输出：启动时间、运行时长、版本、CPU/内存/磁盘关键指标。
- 成本日志落库可查询：最近 N 条明细、按天/按模型汇总、Top 归因。
- 余额可查询且有缓存；失败时不影响 `/status` 其他内容。
- burn rate 与 days left 在无数据/低数据量场景下行为合理（0 除处理、最小样本阈值）。
- 告警具备冷却机制，不会频繁刷屏；触发条件可通过 env 调整。

