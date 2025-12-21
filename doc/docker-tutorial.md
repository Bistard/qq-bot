# Docker 保姆教程（本项目专用）

你说“完全不理解 Docker 是什么，也不理解 Docker 跟我们项目的关系”。这份文档只解决三件事：

1) **Docker 到底是啥**（用最少概念讲清楚）  
2) **为什么这个项目要用 Docker**（NapCat + Bot 的关系）  
3) **你要怎么用 Docker 把项目跑起来**（从 0 到可用，可复制命令）

读完你不需要成为 Docker 专家，但应该能：
- 看懂 `Dockerfile` / `docker-compose.yml` 在干嘛
- 分清 **宿主机**（你的电脑）和 **容器**（Docker 里跑的“隔离小电脑”）
- 知道端口、卷、网络这三个“最容易卡住的点”

---

## 0. 先记住 7 个词（记住就够用）

把 Docker 当成“装软件的另一种方式”：它不是虚拟机，但有点像。

1) **宿主机（Host）**：你的电脑/服务器（你现在敲命令的系统）。  
2) **镜像（Image）**：一个“打包好的软件环境模板”（包含系统库 + 运行时 + 你的程序）。  
3) **容器（Container）**：镜像跑起来后的“进程 + 隔离环境”（可以启动/停止/重启）。  
4) **Dockerfile**：告诉 Docker “怎么做镜像”的菜谱。  
5) **Docker Compose**：一键拉起多个容器，并把它们连起来（一个项目经常不止一个服务）。  
6) **端口映射（Ports）**：把“容器里的端口”暴露给“宿主机端口”，让你能在浏览器/命令行访问。  
7) **数据卷（Volume / bind mount）**：把宿主机的目录挂进容器，保证数据不会因为容器重启而丢。

> 本项目你只需要反复用到：Compose、端口映射、数据卷、以及“容器之间用服务名互相访问”。

---

## 1. Docker 跟我们项目的关系（最重要）

这个项目跑起来其实是**两个东西**：

1) **NapCat（QQ 网关）**：负责扫码登录、保持 QQ 登录态、把 QQ 消息转成 OneBot 事件（WebSocket）。  
2) **Bot（本项目）**：负责连上 NapCat 的 OneBot WS，处理消息 → 调 DeepSeek → 再通过 OneBot 发回 QQ。

Docker 在这里的价值很朴素：
- NapCat 对运行环境、依赖、登录态比较敏感，用容器更稳定
- Bot 需要 Node.js、依赖包、编译产物；用容器可以“你这台机能跑 = 别人那台机也能跑”
- Compose 把它们放进同一个“内部网络”，不用手动配 IP

### 1.1 一张图理解“宿主机 vs 容器”

```
你的电脑（宿主机）
├─ 端口 6099  --->  NapCat 容器:6099  （WebUI）
├─ 端口 3001  --->  NapCat 容器:3001  （OneBot WS 服务端）
└─ 端口 5140（默认） --->  Bot   容器:5140  （/healthz /status）

Docker 内部网络（bot_net）
├─ 服务名 napcat  <-->  Bot 容器通过 ws://napcat:3001 访问 NapCat
└─ 服务名 bot
```

你要特别记住一句话：
- **容器访问容器，用服务名（如 `napcat`）**  
- **宿主机访问容器，用 `localhost:<映射端口>`**

---

## 2. 本项目里哪些文件和 Docker 有关？

你会经常看到这三个文件：

- `Dockerfile`：只负责“怎么把 bot 做成一个镜像”
- `docker-compose.yml`：负责“怎么把 napcat + bot 一起启动，并且配置端口/卷/网络/环境变量”
- `.dockerignore`：告诉 Docker 构建镜像时哪些文件不要打进去（加速、避免塞入私密配置）

### 2.1 `docker-compose.yml`：一键拉起双容器

你不需要看懂全部 YAML，先看这几类信息就够了：

1) **services**：有哪些容器（这里是 `napcat` + `bot`）  
2) **ports**：宿主机端口映射到容器端口  
3) **volumes**：宿主机目录挂载到容器目录（持久化）  
4) **env_file / environment**：把 `.env` 的配置注入容器  
5) **networks**：把两个容器放到同一个内部网络里

本项目关键点（你可以对照 `docker-compose.yml` 看）：
- `napcat`：
  - 端口：`6099`（WebUI）、`3001`（OneBot WS）
  - 卷：
    - `./napcat/config:/app/napcat/config`（NapCat 配置）
    - `./ntqq:/app/.config/QQ`（QQ 登录态/数据，**很重要**）
- `bot`：
  - `build: .`（用本项目的 `Dockerfile` 构建镜像）
  - `env_file: .env`（把你写的配置注入进去）
  - `volumes: ./data:/app/data`（SQLite/状态文件持久化）
  - `ONEBOT_WS_URL` 默认 `ws://napcat:3001`（容器内访问 napcat）

### 2.2 `Dockerfile`：怎么把 bot 打包成镜像

这个 `Dockerfile` 的思路你可以理解为两步：

1) **builder 阶段**：装依赖 → 把 TypeScript 编译成 `dist/`  
2) **runtime 阶段**：只装生产依赖 → 拷贝 `dist/` → `node dist/index.js` 启动

它还做了两件运维友好的事：
- `EXPOSE 5140`：声明容器里服务端口
- `HEALTHCHECK ... /healthz`：让 Docker 知道“服务活着吗”

---

## 3. 你需要先安装什么？（让 `docker` 命令能跑）

### 3.1 你怎么判断自己装没装好？

在任意终端执行：

```bash
docker version
docker compose version
```

如果两条命令都能输出版本号，基本就 OK。

### 3.2 Windows + WSL（你很可能是这个）

你当前路径像 `/mnt/d/...`，通常说明你在 **WSL** 里开发。最省心的方式：

1) 在 Windows 安装 **Docker Desktop**
2) 在 Docker Desktop 里开启 **WSL 集成**（Integration）
3) 重新打开 WSL 终端，确认 `docker version` 可用

> 关键点：在 WSL 里用的 `docker`，通常是“连到 Windows 的 Docker Desktop 引擎”，不是 WSL 自己装一套。

### 3.3 Linux（Ubuntu/Debian）

如果你是纯 Linux 桌面/服务器，建议直接按 Docker 官方文档装 Docker Engine + Compose plugin。

---

## 4. 一键跑起来（Docker Compose 版，推荐）

下面这套流程是“最少脑力版”，按顺序做就行。

### 4.1 第一步：准备 `.env`

在项目根目录执行：

```bash
cp .env.example .env
```

然后编辑 `.env`，至少把这些填好：
- `DEEPSEEK_API_KEY`：DeepSeek API key（必填）
- `BOT_SELF_ID`：机器人 QQ 号（必填，用来过滤自发消息等）
- `ADMIN_IDS`：管理员 QQ（逗号分隔）

一般不用改但你要知道含义的：
- `ONEBOT_WS_URL`：**bot 连接 napcat 的地址**
  - 两个都在 Compose 里跑：保持默认 `ws://napcat:3001`
  - 你把 bot 改成“本地跑”：改成 `ws://localhost:3001`（见第 6 节）

### 4.2 第二步：启动 NapCat（先登录）

```bash
docker compose up -d napcat
docker compose logs -f napcat
```

打开 NapCat WebUI（宿主机浏览器）：

- `http://localhost:6099/webui`

然后扫码登录 QQ。

> **登录态保存在 `./ntqq`**。不要随便删这个目录，否则下次要重新登录。

### 4.3 第三步：在 NapCat 里开启 OneBot WS（服务端）

在 NapCat WebUI 里找到 OneBot 设置：
- 开启 **WebSocket 服务端**
- 端口一般是 `3001`
- 建议设置 `messagePostFormat=array`（本项目依赖 segments 来识别 `@` 和提取文本）
- 如果你设置了 token，把它填到 `.env` 的 `ONEBOT_ACCESS_TOKEN`

### 4.4 第四步：启动 Bot

```bash
docker compose up -d --build bot
docker compose logs -f bot
```

看到 bot 日志里出现“已连接 OneBot / ready”之类的信息，基本就跑起来了。

### 4.5 第五步：健康检查（确认 bot 真的在工作）

```bash
curl http://localhost:5140/healthz
```

正常应该返回 `ok`（或类似内容）。如果你在 `.env` 里改了 `PORT`，这里也要换成对应端口。

---

## 5. 日常运维你只需要记住这些命令

### 5.1 看状态 / 看日志

```bash
docker compose ps
docker compose logs -f bot
docker compose logs -f napcat
```

### 5.2 停止 / 重启

停止全部：
```bash
docker compose down
```

只重启 bot（napcat 不动）：
```bash
docker compose up -d --force-recreate bot
```

改代码后重建 bot 镜像并重启（napcat 不动）：
```bash
docker compose up -d --build --force-recreate bot
```

### 5.3 更省事：用项目自带脚本

本项目有个“把常用命令包起来”的脚本：

```bash
scripts/manage.sh restart
scripts/manage.sh rebuild
scripts/manage.sh stop
scripts/manage.sh bot-logs
scripts/manage.sh napcat-logs
```

### 5.4 进入容器里看一眼（你会突然“理解 Docker”）

很多 Docker 的困惑，进容器里看一眼就明白了：里面就是一个独立的文件系统 + 进程。

进入 bot 容器：
```bash
docker compose exec bot sh
```

你可以在里面执行：
```bash
pwd
ls -la
ls -la /app/data
printenv | grep -E "ONEBOT|DEEPSEEK|PORT|SQLITE|DATA_DIR" || true
```

退出容器：
```bash
exit
```

---

## 6. 进阶但很常用：只让 NapCat 跑 Docker，Bot 本地跑（开发更快）

很多人开发时不想每次改代码都 `docker build`，那就：

1) NapCat 继续用 Compose 跑（稳定、省心）
2) Bot 在本地 `npm run dev`（热更新快）

### 6.1 启动 NapCat（同第 4.2）

```bash
docker compose up -d napcat
```

### 6.2 修改 `.env` 里的 `ONEBOT_WS_URL`

把：
- `ONEBOT_WS_URL=ws://napcat:3001`

改成：
- `ONEBOT_WS_URL=ws://localhost:3001`

解释：  
因为此时 bot 在宿主机跑，它要访问“映射到宿主机的 3001 端口”，而不是 Docker 内部网络的服务名。

### 6.3 本地启动 bot

```bash
npm ci
npm run dev
```

---

## 7. 最常见的卡点与排查（按出现频率排序）

### 7.1 `docker: command not found`

- Docker 没装好，或 Docker Desktop 没开
- Windows + WSL：检查 Docker Desktop 的 WSL Integration 是否开启，然后重开终端

### 7.2 打不开 `http://localhost:6099/webui`

先确认容器在跑：
```bash
docker compose ps
docker compose logs -f napcat
```

如果 6099 被占用，换一个宿主机端口（需要改 `docker-compose.yml` 的映射，比如 `16099:6099`）。

### 7.3 bot 日志显示连不上 OneBot（比如 connection refused）

按这个顺序查：
1) NapCat 是否已启动并开启 WS 服务端（3001）
2) 你 bot 的 `ONEBOT_WS_URL` 写的是不是符合你当前跑法：
   - 都在 Docker：`ws://napcat:3001`
   - bot 本地：`ws://localhost:3001`
3) NapCat 是否启用了 token，但 `.env` 没填 `ONEBOT_ACCESS_TOKEN`（或不一致）

### 7.4 数据“怎么重启就没了？”

通常是卷没挂对/目录被删：
- NapCat 登录态在 `./ntqq`
- bot 数据在 `./data`（SQLite 默认 `data/bot.db`）

只要这两个目录没丢，容器删了重建也能恢复。

---

## 8. 你现在应该形成的心智模型（总结）

- Docker 镜像像“打包好的运行环境”，容器像“运行中的实例”
- Compose 是“这个项目需要两个服务，我帮你一起启动并连起来”
- **容器互访用服务名**，宿主机访问用 **localhost + 映射端口**
- **卷**决定“重启会不会丢数据”：本项目关键卷是 `./ntqq` 和 `./data`

如果你愿意，我也可以在这份文档后面再加一节“逐行解释 `docker-compose.yml`”，把每一行都翻译成中文人话（更像注释版）。
