# 吞噬星空 RAG 智能问答助手

<img width="2560" height="1600" alt="image" src="https://github.com/user-attachments/assets/b8329973-280d-417e-91cf-8371acb48aa3" />



> 一个基于 **RAG（检索增强生成）** 的《吞噬星空》小说智能问答系统：把 1363 章 EPUB 小说切块、向量化存入 Milvus，用户提问时先向量检索原文片段，再交给大模型结合片段生成**带引用来源、流式逐字输出**的回答，并支持**多用户、多会话、历史记录**的完整 Web 应用。

**一句话亮点**：不是"套壳的聊天机器人"，而是一条**数据摄入 → 向量检索 → 大模型生成**完整打通的 RAG 工程链路，并覆盖了 Web 应用该有的**鉴权、数据隔离、流式传输、事务一致性**等真实工程能力。

---

## 一、系统架构

```
┌────────────────────────────────────────────────────────────┐
│                        浏览器（前端）                        │
│  原生 HTML + CSS + JS（无构建工具）                          │
│  登录/注册 · 历史会话侧边栏 · 流式打字机渲染 · 来源折叠 · 音乐  │
└───────────────────────────┬────────────────────────────────┘
                            │ HTTP / JSON / 流式
┌───────────────────────────▼────────────────────────────────┐
│                    Express 后端（server.js）                │
│  路由层：/api/auth  /api/conversations  /api/chat           │
│  中间件：JWT 鉴权（authMiddleware）                          │
│  模型层：userModel / chatModel（数据访问层）                  │
└───────────┬─────────────────────────────┬──────────────────┘
            │                             │
   ┌────────▼────────┐          ┌─────────▼─────────┐
   │    MySQL        │          │  Milvus (Zilliz)  │
   │ 业务数据（落库）  │          │  向量库（检索）    │
   │ sys_user        │          │  ebook8 集合      │
   │ conversations   │          │  IVF_FLAT / COSINE│
   │ messages        │          │  1024 维向量      │
   └─────────────────┘          └───────────────────┘
            │                             ▲
            └───────────┬─────────────────┘
                        │
          ┌─────────────▼──────────────┐
          │  DashScope（阿里云百炼）      │
          │  生成模型：qwen-plus         │
          │  向量模型：text-embedding-v3 │
          └─────────────────────────────┘
```

**核心分工（面试必答）**：
- **MySQL** 存**业务数据**：用户、会话、消息（问答记录）
- **Milvus** 存**知识数据**：小说原文的向量索引（语义检索）
- 两者职责不同：一个是"记对话"，一个是"找知识"

---

## 二、技术栈

| 分类 | 技术 | 用途 |
|------|------|------|
| 后端框架 | Node.js + Express 5 | Web 服务、RESTful API |
| 数据库 | MySQL 8（mysql2/promise） | 用户/会话/消息持久化 |
| 向量数据库 | Milvus（Zilliz Cloud，@zilliz/milvus2-sdk-node） | 原文切块向量存储与相似度检索 |
| 大模型 | DashScope qwen-plus（OpenAI 兼容接口） | 问答生成 |
| 向量模型 | text-embedding-v3（1024 维） | 文本向量化 |
| RAG 工具链 | LangChain（loaders / textSplitters / openai） | EPUB 解析、文本切分、模型封装 |
| 鉴权 | JWT（jsonwebtoken）+ bcrypt | 登录态与密码加密 |
| 书籍解析 | EPubLoader + html-to-text | EPUB 转纯文本 |
| 前端 | 原生 HTML + CSS + JS + marked.js | 页面、Markdown 渲染 |
| 部署 |阿里云服务器部署 | 线上运行 |

---

## 三、实现的功能

### 3.1 数据摄入管道（`npm run ingest`）
- EPUB 小说按章节解析 → 跳过插图短页（`<100` 字符）
- `RecursiveCharacterTextSplitter` 切块：`chunkSize=500`、`overlap=50`（上下文连贯）
- 逐条 embedding 后写入 Milvus `ebook8` 集合（IVF_FLAT 索引、COSINE 度量）
- **逐条串行处理**，规避 DashScope 免费版 QPS 限流

### 3.2 RAG 问答（`npm run rag`，CLI 版）
- 提问 → 向量化 → Milvus 检索 top-k → 拼 prompt → LLM 回答
- 打印每条命中的**章节号 + 相似度分数 + 原文**，链路透明可验证

### 3.3 Web 智能问答助手（`npm start`）
- **用户系统**：注册 / 登录（bcrypt 加密、JWT 鉴权、防用户名枚举）
- **多会话管理**：自动建会话、历史会话列表、点击切换、删除
- **RAG 检索 + 来源展示**：回答附带命中的章节号、相似度、原文片段（可折叠展开）
- **流式输出**：回答像 ChatGPT 一样逐字浮现（打字机效果），而非转圈等待
- **多用户数据隔离**：每个用户只能看到/操作自己的会话（`WHERE id AND user_id`）
- **历史侧边栏**：可折叠、localStorage 记住状态
- **氛围功能**：全图背景、透明 UI、背景图轮播、音乐播放（`bgm.mp3`）

---

## 四、快速开始

### 1. 配置环境变量（`.env`，参照 `.env.example`）
```
# 大模型（DashScope 阿里云百炼）
MODEL_NAME=qwen-plus
OPENAI_API_KEY=sk-你的_DashScope_API_Key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDINGS_MODEL_NAME=text-embedding-v3

# 向量库（Zilliz Cloud）
MILVUS_ADDRESS=https://你的集群地址...zilliz.com.cn
MILVUS_TOKEN=你的_Zilliz_Token

# MySQL
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USER=root
DB_PASSWORD=你的_MySQL_密码
DB_NAME=rag_system

# JWT
JWT_SECRET=你的_JWT_密钥
JWT_EXPIRES_IN=2h
```

### 2. 建表（MySQL）
```sql
CREATE TABLE sys_user (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(100) NOT NULL,          -- bcrypt 哈希
  nickname VARCHAR(30),
  role VARCHAR(20) DEFAULT 'user',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE conversations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  title VARCHAR(100),
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user (user_id, update_time)
);

CREATE TABLE messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  role VARCHAR(10) NOT NULL,               -- user / assistant
  content TEXT NOT NULL,
  sources JSON NULL,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conv (conversation_id, create_time)
);
```

### 3. 安装与运行
```bash
npm install
npm run ingest   # ① 摄入小说数据到 Milvus（首次）
npm start        # ② 启动 Web 服务，浏览器访问 http://localhost:3000
```

---

## 五、项目结构

```
tsxkRAG/
├── src/
│   ├── main.mjs          # 数据摄入：EPUB → 切块 → 向量化 → 入库
│   ├── query.mjs         # 向量检索验证脚本
│   ├── rag.mjs           # RAG 问答 CLI（检索 + 生成）
│   ├── server.js         # Web 主服务（含流式 /api/chat）
│   ├── middleware/auth.js# JWT 鉴权中间件
│   ├── routes/
│   │   ├── auth.js       # 登录 / 注册 / 个人信息
│   │   └── chat.js       # 会话 CRUD
│   ├── models/
│   │   ├── db.js         # MySQL 连接池 + 参数化查询封装
│   │   ├── userModel.js  # 用户表操作
│   │   └── chatModel.js  # 会话/消息表操作（含事务）
│   └── utils/jwt.js      # JWT 签发/校验封装
├── public/
│   ├── index.html        # 单页前端（登录/会话/流式/音乐/背景）
│   └── assets/           # 音频、图片
├── .env.example          # 环境变量模板
└── package.json
```

---

## 六、核心实现讲解（面试重点）

### 6.1 RAG 检索 → 生成链路（server.js）
```js
// ① 用户问题向量化
const queryVector = await getEmbedding(question)
// ② Milvus 向量检索 top-5，COSINE 相似度
const searchResult = await client.search({
  collection_name: COLLECTION_NAME,
  vectors: [queryVector],
  limit: k,
  metric_type: MetricType.COSINE,
  output_fields: ['id', 'content', 'book_id', 'chapter_num'],
})
// ③ 检索片段拼进 prompt
const prompt = buildPrompt(question, results)
// ④ 大模型流式生成
const stream = await model.stream([new SystemMessage(prompt)])
```

### 6.2 流式输出（打字机效果）
- **后端**：`model.stream()` 逐 chunk `res.write()`；先发一行 `meta JSON`（`{conversationId, sources}`），再流式正文
- **前端**：`fetch` + `res.body.getReader()` + `TextDecoder('utf-8')` 边读边用 `marked.parse` 渲染
- **三个关键点**：
  1. `TextDecoder` 解决中文被拆到两个 chunk 时乱码
  2. `X-Accel-Buffering: no` 防止 Nginx 等网关缓冲导致"不流式"
  3. meta 行先发，让前端**先渲染检索来源**、再流式填正文，来源不丢失

### 6.3 数据隔离与越权防护
- `getConversation(id, userId)` 使用 `WHERE id = ? AND user_id = ?`
- 所有会话接口（查看/删除/续聊）都带 `authMiddleware`，`userId` 取自 JWT（**不信前端传**）
- 越权访问直接返回 404/403

### 6.4 事务保证删除一致性
删除会话时先删 `messages` 再删 `conversations`，用 `pool.getConnection()` 拿到**同一连接**手动开启事务，失败回滚，避免"会话删了消息残留"。

### 6.5 安全实践
- 密码 **bcrypt 哈希**（成本因子 10），不存明文
- 全程 **参数化查询**（`?` 占位符），防 SQL 注入
- "用户不存在"与"密码错误"返回**同一提示**，防用户名枚举
- `JWT_SECRET` 走环境变量，不硬编码；token 载荷剔除密码字段
- 前端渲染用 `textContent` 而非 `innerHTML`，防 XSS

---

## 七、遇到的问题与优化思路

| # | 问题 | 优化思路 / 做法 |
|---|------|----------------|
| 1 | 回答一次性输出，等很久、体验差 | 改为**流式输出**（打字机），首字秒出 |
| 2 | 流式改造后检索来源（章节/分数/原文）会丢 | **meta 行先发** sources，前端先渲染来源区再流式正文 |
| 3 | 中文跨 chunk 被切断出现乱码 | `TextDecoder('utf-8', { stream: true })` 自动拼接 |
| 4 | 接入网关（Nginx）后流式失效 | 加 `X-Accel-Buffering: no` |
| 5 | 登录硬编码，无法注册、无法按用户存数据 | 升级 **MySQL + bcrypt + JWT**，多用户隔离 |
| 6 | 会话删除可能残留消息（不一致） | **数据库事务**保证原子性 |
| 7 | DashScope 免费版 QPS 受限，并发 embedding 被限流 | **逐条串行**处理摄入 |
| 8 | 整页滚动、左右滚动不独立 | 视口高度锁死 + 内部区域各自 `overflow-y: auto` |
| 9 | 滚动条抢眼 | 极细（4px）+ 半透明滑块，既能定位又不干扰 |
| 10 | 向量检索是**单路稠密检索**，无重排 | 后续可升级：**混合检索**（BM25+向量，RRF 融合）扩召回 → **重排**（bge-reranker）提精度 → 封装成可配置 **Query Pipeline** |

---

## 八、踩坑与解决方案(真实踩坑经历)

### 坑 1：DashScope 免费版 QPS 限流
- **现象**：摄入小说时并发 embedding 频繁报限流错误。
- **原因**：免费版有 QPS 上限，`Promise.all` 并发请求触发。
- **解法**：改为**逐条串行**生成向量再批量插入。
- **收获**：调用第三方 API 前要了解其限流策略，工程上要控制并发。

### 坑 2：COLLECTION_NAME 不一致，检索到"别的书"
- **现象**：问答返回《天龙八部》的内容，与《吞噬星空》无关。
- **原因**：query 脚本里 collection 写成了 `ebook4`，实际数据在 `ebook8`。
- **解法**：统一三个入口（main/query/server）的 `COLLECTION_NAME`。
- **收获**：配置常量要单一来源、全局一致，跨文件靠人工同步容易出错。

### 坑 3：pnpm / npm 混用被沙箱拦截
- **现象**：`pnpm add` 卡在 store 目录（指向受限路径），npm 崩溃。
- **原因**：pnpm 全局 store 指向受限路径，npm 无法解析 pnpm 的符号链接 node_modules。
- **解法**：把 store 复制到项目内 + `--store-dir` 重链。
- **收获**：理解 pnpm 的 store（全局缓存+硬链接）机制，以及 npm/pnpm 不能混用。

### 坑 4：sys_user 表缺 role 字段
- **现象**：JWT payload 想带 `role`，但表里没有该列。
- **解法**：`ALTER TABLE sys_user ADD COLUMN role VARCHAR(20) DEFAULT 'user'`。
- **收获**：Schema 演进是常态，新增字段要设 `DEFAULT` 避免影响存量数据。

### 坑 5：catch 块变量名不匹配导致运行时崩溃
- **现象**：`catch (error)` 里却用了 `err`，报 `ReferenceError`。
- **解法**：保持 catch 参数名与块内引用一致。
- **收获**：低级但致命，代码规范（命名一致）能避免。

### 坑 6：文件路径字符串必须精确匹配
- **现象**：读不到 EPUB / 音频文件。
- **原因**：磁盘文件名含空格/特殊字符，路径字符串与真实文件名不一致。
- **解法**：路径照抄实际文件名，必要时 `encodeURIComponent`。

### 坑 7：浏览器音频自动播放被拦截
- **现象**：页面加载后背景音乐不响。
- **原因**：浏览器要求用户交互后才能播放音频。
- **解法**：用户点击页面任意位置 / 音乐按钮后才 `audio.play()`。

### 坑 8：后端改动后接口不生效
- **现象**：改了路由，前端仍 404。
- **原因**：Node 进程未重启，改动未加载。
- **解法**：每次改后端代码必须重启服务（`Ctrl+C` 后重新 `node src/server.js`）。

### 坑 9：敏感配置进 Git
- **现象**：`.env`（含 DashScope Key、Zilliz Token）可能被提交到仓库。
- **解法**：`.env` 加入 `.gitignore`，只提交 `.env.example` 模板；`JWT_SECRET` 从环境变量读取。
- **收获**：密钥泄露 = 凭据被滥用，必须环境变量注入 + 模板文件协同。

### 坑 10：仓库文件超 GitHub 100MB 限制
- **现象**：`public/assets.tar`（打包的素材）过大无法 push。
- **解法**：`.gitignore` 忽略 `*.tar`，素材从资源目录读取。
- **收获**：大文件不该进 Git，用外部存储或资源目录。

### 坑 11：Railway 部署构建失败
- **现象**：Railway 无法启动 Node 项目。
- **原因**：未显式配置 build/start 命令。
- **解法**：配置 `build: npm install`、`start: node src/server.js`，端口用 `process.env.PORT || 3000`。

---

## 九、项目亮点总结（自我评价）

1. **完整的 RAG 工程链路**：摄入（EPUB→切块→向量化→入库）→ 检索（Milvus top-k）→ 生成（流式），从数据到问答全部打通，且可复现验证。
2. **真实的 Web 工程能力**：JWT 鉴权、bcrypt 密码、多用户数据隔离、事务一致性、参数化查询防注入——不是 demo，是有安全意识的工程。
3. **流式输出体验**：ChatGPT 式打字机 + 来源溯源，兼顾效果与原理（ReadableStream / TextDecoder / 网关缓冲）。
4. **业务数据与向量数据分离**：MySQL 管"对话记录"，Milvus 管"知识检索"，讲得清分工。
5. **踩坑多、复盘深**：限流、集合名不一致、沙箱、自动播放等 11 个坑都沉淀成了解决方案。

---

## 十、后续优化方向

- [ ] **混合检索**：BM25 稀疏检索 + 向量稠密检索，RRF 融合，解决人名/数字等精确词召回差
- [ ] **重排（Rerank）**：bge-reranker 对 top-k 精排，提升送入 prompt 的质量
- [ ] **Query Pipeline 化**：把检索-生成链路封装成可配置、可缓存、可流式的组件
- [ ] **会话标题智能生成**：用 LLM 根据首条问题自动生成
- [ ] **消息分页**：长会话历史接口分页加载，避免一次拉全量

---

## 十一、部署指南（阿里云 ECS + Docker Compose）

### 11.1 部署架构

```
用户浏览器
   │ HTTP(80)
┌──▼──────────────┐
│   Nginx 反代      │  proxy_buffering off（保证流式打字机）
└──┬──────────────┘
┌──▼──────────────┐
│  app 容器:3000    │  Node + Express + RAG
└──┬──────────────┘
   │ 容器网络内连 mysql 服务
┌──▼──────────────┐
│ mysql 容器:3306   │  数据卷持久化，initdb.d 自动建表
└──────────────────┘
   ├── Milvus（云端，环境变量注入）
   └── DashScope（云端，环境变量注入）
```

### 11.2 部署产物

| 文件 | 作用 |
|------|------|
| [docker-compose.yml](file:///d:/test/demo-吞噬星空1.0/tsxkRAG/docker-compose.yml) | 一键编排 mysql + app + nginx 三服务 |
| [Dockerfile](file:///d:/test/demo-吞噬星空1.0/tsxkRAG/Dockerfile) | node:20-slim 镜像，bcrypt 原生模块可用 |
| [.dockerignore](file:///d:/test/demo-吞噬星空1.0/tsxkRAG/.dockerignore) | 排除 .env / node_modules / *.tar / 文档 |
| [deploy/schema.sql](file:///d:/test/demo-吞噬星空1.0/tsxkRAG/deploy/schema.sql) | MySQL 首次启动自动建三张表 |
| [deploy/nginx.conf](file:///d:/test/demo-吞噬星空1.0/tsxkRAG/deploy/nginx.conf) | 反向代理 + 关闭缓冲保流式 |

### 11.3 部署步骤

```bash
# 1. 在 docker-compose.yml 同级放置 .env（参照 .env.example 填写真实生产值）
#    - DB_HOST 填 mysql、DB_PORT 填 3306（容器内用服务名互访）
#    - JWT_SECRET 用高强度随机值

# 2. 构建并启动全套
docker compose up -d --build

# 3. 查看状态
docker compose ps

# 4. 访问
#    http://服务器公网IP  （nginx 80 端口入口）
```

### 11.4 数据迁移（可选，把本地 dev 数据带上去）

```bash
# 本地导出
docker exec rag-mysql8 mysqldump -uroot -p<密码> rag_system > rag_system_dump.sql
# 传到服务器后导入
docker exec -i rag-mysql8 mysql -uroot -p<密码> rag_system < rag_system_dump.sql
```

### 11.5 生产要点

1. **MySQL 数据持久化**：`mysql-data` 数据卷挂载，容器重建不丢数据（备份用 `mysqldump` 定时导出）。
2. **流式输出**：nginx 已配置 `proxy_buffering off` + `proxy_cache off`，配合后端 `X-Accel-Buffering: no`，打字机效果在线生效。
3. **bcrypt 原生模块**：用 `node:20-slim`（Debian 系）官方镜像，避免 alpine 上编译失败。
4. **大素材**：`.tar` 已进 `.gitignore` 和 `.dockerignore`，通过 `public/assets/` 由 Express 静态托管。
5. **安全组**：阿里云控制台放行 80 端口（Nginx 入口）；3306 数据库端口无需对外暴露（容器内网络互访）。
6. **HTTPS（建议）**：生产用域名后可在 nginx 增加 443 server 配置 SSL 证书。

