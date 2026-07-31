# 吞噬星空 RAG 智能问答助手


<img width="2542" height="1326" alt="e943b6fd453a62877c5a037a8a76fa2d" src="https://github.com/user-attachments/assets/b3e36fba-6b38-40fc-9db8-84339b30f8d7" />

> 基于向量检索（Milvus）+ 大语言模型（DashScope / 通义千问）的《吞噬星空》小说智能问答系统。
> RAG（Retrieval-Augmented Generation）架构，结合小说原文片段进行精准回答。

---

## 功能特性

- 🧠 **AI 智能问答**：基于小说内容回答问题，引用原文片段佐证
- 🔍 **向量检索**：Milvus 相似度匹配，快速检索相关章节
- 📖 **来源追踪**：回答附带检索来源，可展开查看原文和相似度
- 🖼️ **动态背景**：图片轮播，自动切换吞噬星空主题壁纸
- 🎵 **背景音乐**：内置主题音乐播放，可随时开关
- 💬 **简洁界面**：纯前端 HTML + CSS + JS，无需构建工具
- 🌐 **Web 界面**：Express 提供 HTTP 服务，浏览器直接访问

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端运行时 | Node.js (>= 16) |
| Web 框架 | Express 5.x |
| 向量数据库 | Milvus / Zilliz Cloud |
| LLM / Embedding | 阿里云 DashScope（通义千问） |
| RAG 框架 | LangChain (LangChain.js) |
| EPUB 解析 | epub2 + html-to-text |
| 前端 | 原生 HTML / CSS / JavaScript（无框架） |

---

## 项目结构

```
tsxkRAG/
├── src/
│   ├── main.mjs              # EPUB 解析 + 分块 + 向量入库
│   ├── query.mjs             # 命令行查询测试
│   ├── rag.mjs               # RAG 核心逻辑（命令行版）
│   └── server.mjs            # Express Web 服务（推荐使用）
├── public/
│   ├── index.html            # 前端主页面
│   └── assets/
│       ├── images/           # 背景图片素材（jpg/png/webp 等）
│       └── audio/            # 背景音乐素材（mp3/wav 等）
├── .env                      # 环境变量（不提交 git）
├── .env.example              # 环境变量模板
├── .gitignore                # Git 忽略规则
├── .gitattributes            # Git 换行符/二进制设置
├── package.json              # 项目依赖和命令
└── pnpm-lock.yaml            # 依赖锁定
```

---

## 快速开始

### 1. 安装依赖

推荐使用 `pnpm`，也可使用 `npm` / `yarn`：

```bash
pnpm install
# 或 npm install
# 或 yarn install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，填入你的真实 Key：

```bash
# Windows (PowerShell)
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```

编辑 `.env`，填写以下内容：

```env
# 大语言模型（通义千问）
MODEL_NAME=qwen-plus
OPENAI_API_KEY=sk-你的_DashScope_API_Key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# 向量嵌入模型
EMBEDDINGS_MODEL_NAME=text-embedding-v3

# Milvus / Zilliz Cloud
MILVUS_ADDRESS=https://你的集群地址.serverless.ali-cn-hangzhou.cloud.zilliz.com.cn
MILVUS_TOKEN=你的_Zilliz_API_Token
```

**获取 Key 的地址：**
- DashScope API Key：<https://dashscope.console.aliyun.com/apiKey>
- Zilliz Cloud Token：<https://cloud.zilliz.com.cn/>

### 3. 放入素材（可选）

```bash
# 图片素材 → 支持 jpg/jpeg/png/gif/webp/bmp
# 复制到：
public/assets/images/

# 背景音乐 → 支持 mp3/wav/ogg/flac/m4a
# 复制到：
public/assets/audio/
```

*注：不放入素材也能运行，只是没有背景轮播和音乐。*

### 4. 入库 EPub 小说

把你的《吞噬星空》`.epub` 文件放到项目根目录，确认 `src/main.mjs` 中 `EPUB_FILE` 路径正确。

然后执行入库：

```bash
pnpm run ingest
# 或 node src/main.mjs
```

等待全部章节切分并插入 Milvus（约 1500+ 章节）。

### 5. 启动 Web 服务

```bash
pnpm start
# 或 node src/server.mjs
```

看到提示即成功：

```
吞噬星空 RAG 助手已启动！
打开浏览器访问: http://localhost:3000
```

在浏览器打开 **http://localhost:3000** 即可使用。

---

## 命令速查

| 命令 | 说明 |
|------|------|
| `pnpm run ingest` | 解析 EPUB 并将章节向量存入 Milvus（只需运行一次） |
| `pnpm start` | 启动 Web 问答服务（推荐） |
| `pnpm run query` | 命令行模式查询测试 |
| `pnpm run rag` | 命令行模式完整 RAG 问答 |

---

## 常见问题

### Q: 打开页面没有背景音乐？
A: 浏览器自动播放限制，点击页面任意位置或右上角音乐按钮即可播放。也请确认 `public/assets/audio/` 里有音乐文件。

### Q: 背景图片没显示？
A: 把图片放入 `public/assets/images/`，支持 jpg/png/webp 等格式。图片会自动扫描并轮播。

### Q: 回答说「不知道」或答非所问？
A: 可能 Milvus 里的集合为空或错了。检查 `src/server.mjs` 中 `COLLECTION_NAME` 是否和入库时的一致，并确认 EPUB 已成功入库。

### Q: 音乐/图片文件名很长或包含中文怎么办？
A: 完全没问题，代码已自动对 URL 编码处理。

### Q: 可以部署到服务器吗？
A: 可以。推荐：
- **演示/本地**：直接 `node src/server.mjs`
- **长期运行**：用 `pm2` 守护进程
- **云平台**：Render / Railway / 阿里云轻量服务器
- 注意：`.env` 的 Key 在生产环境也需要配置

---

## 安全提示

- **绝对不要**把 `.env` 文件提交到 Git / GitHub（.gitignore 已忽略）
- **不要**把包含真实 API Key 的 `.env` 发给任何人
- DashScope / Zilliz 账号注意设置 API Key 额度和白名单，防止盗刷

---

## License

ISC
