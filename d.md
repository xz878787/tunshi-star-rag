# 吞噬星空 RAG 助手 · 项目全景逻辑链（d.md）

> 本文用 **9 张图 + 逐图详解**，按「先看骨架、再串流程、最后看数据与部署」的顺序，
> 把项目从一次请求到一次部署的完整逻辑链画清楚。所有节点名、参数、阈值、文件路径均与源码一致。
>
> 阅读顺序：图1 项目地图 → 图2 总体架构 → 图3 一次问答时序 → 图4 状态机 → 图5 检索管线
> → 图6 稀疏后端选择 → 图7 数据摄入 → 图8 记忆与落库 → 图9 部署拓扑。

---

## 图 1 · 项目地图：代码分层与职责

```mermaid
flowchart TD
    subgraph FE["前端 public/（原生 HTML+CSS+JS，无构建工具）"]
        HTML["index.html<br/>单页界面（登录/侧栏/聊天区/背景音画）"]
        JS["js/ 8 个模块<br/>main.js 入口 · auth.js 登录注册 · conversation.js 会话列表<br/>chat.js 消息状态 · ragApi.js NDJSON 流式请求/解析<br/>sourceRender.js 来源渲染 · utils.js token 工具 · media.js 音画"]
    end

    subgraph BE["后端 src/（Express 5 + ES Module，package.json type:module）"]
        SRV["server.js<br/>HTTP 编排：/api/chat 流式胶水 + 滑动摘要维护"]
        RT["routes/<br/>auth.js 登录注册 · chat.js 会话 CRUD"]
        MW["middleware/auth.js<br/>JWT Bearer 校验"]
        MDL["models/<br/>userModel.js · chatModel.js（数据访问层）· db.js 连接池"]
        GRAPH["ragGraph.mjs<br/>★ 核心：LangGraph 7 节点状态机"]
        AUG["rag/queryAugment.mjs<br/>同义扩展（结构化输出改写）"]
        HYBRID["rag/hybridRetrieval.mjs<br/>rrfFuse 纯函数（k=60）"]
        SPARSE["rag/sparseRecall.mjs<br/>稀疏路统一入口（ES/内存双后端）"]
        CORPUS["rag/sparseCorpus.mjs<br/>EPUB 重算 11977 条稀疏语料"]
        BM25["rag/bm25Index.mjs<br/>纯 JS BM25（中文 bigram，k1=1.2 b=0.75）"]
        RRK["rerank/dashscopeRerank.mjs<br/>DashScope text-rerank 重排器"]
        INGEST["main.mjs（npm run ingest）<br/>EPUB→切片→embedding→Milvus"]
        SYNC["syncEsIndex.mjs（npm run sync:es）<br/>稀疏语料→ES 倒排索引"]
        UTIL["utils/jwt.js 签发/校验"]
    end

    subgraph DATA["数据层"]
        DB[("MySQL 8.0<br/>sys_user / conversations / messages")]
        MV[("Milvus / Zilliz Cloud<br/>集合 ebook8 · IVF_FLAT · COSINE · 1024 维")]
        ES[("Elasticsearch 8.17（可选）<br/>索引 tsxk_starry_sky · IK 分词")]
    end

    subgraph EXT["外部模型/服务"]
        QW["DashScope OpenAI 兼容接口<br/>生成模型 temp=0.7 · 规划模型 temp=0<br/>text-embedding-v3（1024 维）"]
        RRKAPI["DashScope rerank API<br/>qwen3-rerank"]
        BC["博查 Web Search API<br/>POST /v1/web-search"]
    end

    HTML --> JS
    JS -->|"POST /api/chat 等"| SRV
    SRV --> RT --> MW --> MDL --> DB
    SRV -->|"runAgenticRAG + sink 回调"| GRAPH
    GRAPH --> AUG & HYBRID & SPARSE & RRK
    SPARSE --> CORPUS & BM25
    SPARSE -.->|"SPARSE_BACKEND=auto/es"| ES
    GRAPH --> MV
    GRAPH --> QW
    RRK --> RRKAPI
    GRAPH --> BC
    INGEST --> MV
    SYNC --> ES
    MW --> UTIL

    classDef fe fill:#eef2ff,stroke:#818cf8,color:#312e81
    classDef core fill:#14532d,stroke:#22c55e,color:#eafff0
    classDef newn fill:#7c2d12,stroke:#fb923c,color:#ffe8d6
    classDef data fill:#0f172a,stroke:#64748b,color:#e2e8f0
    class HTML,JS fe
    class GRAPH core
    class AUG,HYBRID,SPARSE,CORPUS,BM25,RRK,SYNC newn
    class DB,MV,ES data
```

**怎么读这张图**

- **绿色节点 [ragGraph.mjs](src/ragGraph.mjs)** 是系统心脏：HTTP 层不做任何 RAG 逻辑，只把请求交给它、把它的回调转成 HTTP 流。
- **橙色节点是混合检索改造新增的 7 个文件**：同义扩展、RRF 融合、稀疏召回、EPUB 语料重算、纯 JS BM25、DashScope 重排器、ES 灌库脚本。
- **两条数据写入链与在线问答链完全分离**：[main.mjs](src/main.mjs) 灌 Milvus、[syncEsIndex.mjs](src/syncEsIndex.mjs) 灌 ES，都是离线一次性脚本，不参与线上请求。
- 后端分层是标准的 **route → middleware → model**：[routes/](src/routes/) 只映射 URL，[models/chatModel.js](src/models/chatModel.js) 只写 SQL（全部 `?` 参数化），业务编排在 [server.js](src/server.js) 和 ragGraph。
- 前端 8 个 JS 模块全是原生 ES Module，`public/` 整个目录由 `express.static` 直接托管。

---

## 图 2 · 总体架构：运行时拓扑

```mermaid
flowchart LR
    subgraph CLIENT["浏览器"]
        UI["单页应用<br/>fetch + ReadableStream 逐行读 NDJSON<br/>marked 渲染 Markdown"]
    end

    subgraph NODE["Node.js 进程（Express 5，端口 PORT||3000）"]
        direction TB
        STATIC["静态资源托管<br/>express.static(public)"]
        AUTH["/api/auth/*<br/>登录注册（bcrypt + JWT）"]
        CONV["/api/conversations/*<br/>会话 CRUD（全部要登录）"]
        CHAT["/api/chat<br/>NDJSON 流式问答（全部要登录）"]
        MEDIA["/api/audio · /api/images<br/>本地素材目录列表"]
        ENGINE["LangGraph 图引擎（单例）<br/>模型客户端 / Milvus 客户端 / 重排器 / BM25 索引<br/>均为模块级单例，启动时初始化"]
        CHAT --> ENGINE
    end

    subgraph POOL["MySQL 连接池（mysql2，connectionLimit=10）"]
        T1[("sys_user")]
        T2[("conversations")]
        T3[("messages")]
    end

    UI -->|"HTTPS（线上经 Nginx 反代，关缓冲）"| STATIC & AUTH & CONV & CHAT
    AUTH --> T1
    CONV --> T2 & T3
    CHAT --> T2 & T3
    ENGINE -->|"COSINE 向量检索"| MILVUS["Zilliz Cloud / Milvus<br/>ebook8"]
    ENGINE -->|"BM25 关键词检索（可选）"| ESVC["Elasticsearch<br/>或进程内 BM25"]
    ENGINE -->|"chat / embed / rerank"| DASH["DashScope"]
    ENGINE -->|"summary:true 摘要级搜索"| BOCHA["博查搜索"]

    classDef node fill:#0f2f26,stroke:#34d399,color:#d9fff1
    classDef ext fill:#1f2937,stroke:#6b7280,color:#f9fafb
    classDef hot fill:#7c2d12,stroke:#fb923c,color:#ffe8d6
    class STATIC,AUTH,CONV,MEDIA node
    class CHAT,ENGINE hot
    class MILVUS,ESVC,DASH,BOCHA ext
```

**关键点**

1. **图引擎是模块级单例**：模型客户端、Milvus 客户端、重排器、进程内 BM25 索引在进程启动时初始化一次（`initRagGraph()`：连 Milvus + loadCollection + `warmupSparseBackend()`），请求间复用。
2. **问答接口只有一个热点 `/api/chat`**，其余都是普通 JSON 接口。它与普通接口的区别是响应体不是 JSON，而是 **NDJSON 事件流**（图 3 详解）。
3. **四个外部依赖，三个可降级**：Milvus 是唯一硬依赖；DashScope 重排未配置时退化为 COSINE 排序；ES 不可用时稀疏路退化为进程内 BM25；博查 Key 缺失时跳过联网。
4. **Nginx 在线上只做一件与本系统强相关的事**：反向代理 + 关闭响应缓冲（后端也主动发 `X-Accel-Buffering: no`），否则打字机效果会被攒成一大段。

---

## 图 3 · 一次问答的端到端时序（最核心的一条链）

```mermaid
sequenceDiagram
    autonumber
    participant U as 浏览器
    participant S as Express /api/chat
    participant DB as MySQL
    participant G as LangGraph 图引擎
    participant R as 检索/模型服务

    U->>S: POST /api/chat（Bearer JWT，{question, conversationId?}）
    S->>S: authMiddleware 校验 JWT → req.user.userId
    alt 带了 conversationId
        S->>DB: getConversation(id, userId) 归属校验（防越权）
    else 没带
        S->>DB: createConversation（标题=问题前 20 字）
    end
    S->>DB: getMemoryState：摘要 + 最近 8 条消息
    S->>DB: appendMessage(user 问题)
    S-->>U: ① meta 事件（conversationId）
    S->>G: runAgenticRAG（k=5，maxRetrievalCount=5，context，sink）

    loop 图执行（节点经 sink 回调往外推）
        G-->>S: onThink（路由/拆解/每轮检索/规划…）
        S-->>U: ② think 事件（多条，实时）
        G->>R: embedding + 双通道召回 + RRF + 重排 / LLM
        G-->>S: onSources（库内片段+网页，正文前先发）
        S-->>U: ③ sources 事件（仅一次）
        G-->>S: onToken（逐 token）
        S-->>U: ④ token 事件（多条，打字机）
    end

    G-->>S: 最终 state（generation/documents/webDocs）
    S-->>U: ⑤ done 事件（elapsed 总秒数）
    S->>DB: appendMessage(assistant 完整回答, sources JSON, thinking JSON)
    S-->>S: 异步 maintainSummary（不阻塞响应，失败回退纯滑窗）
```

**逐段拆解**

- **第 1~4 步（准入与归属）**：JWT 解析失败返回 401（区分过期/非法两种文案）；会话 id 必须与 userId 同时匹配，查不到直接 403——水平越权防护。
- **第 5 步（拼记忆）**：`conversationContext = 【历史摘要】… + 最近 8 条消息`，两者靠 `summary_upto_id` 无缝衔接（图 8 详解）。
- **第 7 步起（流）**：响应头 `Content-Type: text/plain` + `X-Accel-Buffering: no`，`send()` 每写一个对象就换行。**事件顺序是协议契约**：`meta → think* → sources → token* → done`。前端 [ragApi.js](public/js/ragApi.js) 用 `TextDecoder(stream:true)` + 按 `\n` 切包，专门处理中文字符被 TCP 包切断的问题，坏行直接跳过、断网保留半截正文。
- **sink 注入方式**：回调集合通过 `graph.invoke(input, { configurable: { sink } })` 传入，不走全局变量——并发请求各自持有各自的 `res`，天然隔离。
- **落库在流结束之后**：先把整段回答吐给用户，再写 assistant 消息（含 sources、thinking 两个 JSON 列），用户不等数据库。
- **生产参数**：`k=5`、`maxRetrievalCount=5`（[server.js 第 154-155 行](src/server.js#L154-L155)）；注意评测脚本 [run-project-eval.mjs](eval/run-project-eval.mjs) 用的是 3，对比数据时不要混。

---

## 图 4 · LangGraph 状态机全景（7 节点 + 条件边）

```mermaid
flowchart TD
    START(["START"]) --> ROUTE["① route_question 路由<br/>planModel + RouteSchema（zod）<br/>输出 simple / complex / web + reason"]

    ROUTE -->|"simple 常识"| DIRECT["② direct_answer 直答<br/>主模型流式，不检索不查库"]
    ROUTE -->|"web 库外资讯<br/>作者/动画/跨作品"| WEB["⑥ web_search 博查联网<br/>最多 8 条，独立存 webDocs"]
    ROUTE -->|"complex 小说情节"| DECOMP["③ decompose_question 拆解<br/>DecomposeSchema：1~8 条有序子问题<br/>禁指代 · 结论层排前 1~3 位"]

    DECOMP --> RET["④ retrieve 单轮检索<br/>消费 subQuestions[nextSubIdx] 一条<br/>retrieveWithRerank 管线（图5）<br/>mergeUnique 跨轮跨通道去重"]

    RET --> AR{"afterRetrieve 条件<br/>剩余子问题≤0 或 轮数≥上限？"}
    AR -->|"否：还有且未到顶"| PLAN["⑤ plan_next_step 规划<br/>NextStepSchema：retrieve/generate/web_search<br/>附 3 条硬规则兜底（不信 LLM）"]
    AR -->|"是 + 最高分&lt;0.55 + 没联网过"| WEB
    AR -->|"是 + 证据足够"| GEN["⑦ rag_generate 生成<br/>先推 sources，再流式正文<br/>库内/网页上下文分块标注"]

    PLAN -->|"retrieve"| RET
    PLAN -->|"web_search"| WEB
    PLAN -->|"generate"| GEN

    WEB --> GEN
    DIRECT --> END(["END"])
    GEN --> END

    classDef node fill:#0f2f26,stroke:#34d399,color:#d9fff1
    classDef plan fill:#bbf7d0,stroke:#22c55e,color:#14532d
    classDef webn fill:#f59e0b,stroke:#fbbf24,color:#3b2a00
    classDef dia fill:#e0e7ff,stroke:#818cf8,color:#312e81
    class ROUTE,DECOMP,DIRECT,RET,GEN node
    class PLAN plan
    class WEB webn
    class AR dia
```

**护栏与设计点（面试高频）**

1. **三条路径一次路由定终身**：simple 直答最省；web 跳过整个检索；complex 才进多跳循环。路由 prompt 里明确喂入对话上下文，但标注「仅用于理解指代，不可作为小说事实依据」。
2. **拆解的两条 prompt 铁律**：① 禁止「他/她/此人」等指代——每条子问题要独立去 embedding，指代必须在此消解；② 结论层优先（前 1~3 位）——因为检索轮数有硬顶，排后面的子问题可能轮不到。
3. **afterRetrieve 先于规划器做硬分流**：子问题查完或轮数到顶时，**直接**分流 generate/web_search，跳过一次规划 LLM 调用（省 3~6 秒）；只有「还能继续查」时才花钱问规划器。
4. **低分联网阈值 0.55**：`lastTopScore` 只取稠密路 COSINE 最高分（库内正常命中 0.63~0.77，库外主题实测 0.4~0.55）。BM25 分和 rerank 分被严格排除在外，否则阈值静默失效。
5. **规划器输出不信任**：即使 LLM 说 web_search，若已联网过则强制改 generate；说 retrieve 但没有剩余子问题/轮数到顶也强制 generate。
6. **三重循环保护，图必收敛**：检索轮数硬顶（生产 5 / 评测 3）＞ 子问题数量 ≤8 ＞ `webSearched` 单次联网闸门。最坏路径 = 5 次检索 + 1 次联网。
7. **生成节点的两个兜底**：库内网页双空 → 固定话术「抱歉，没有在《吞噬星空》中找到相关内容。」；sources 事件保证在正文之前发出，极端情况由 server.js 用最终 state 补发。

---

## 图 5 · 单轮检索管线（retrieveWithRerank 内部全貌）

```mermaid
flowchart TD
    IN(["输入：当前子问题 q · 本轮保留条数 k=5"]) --> WIDE{"重排器存在？<br/>（RERANK_ENABLED 且配了 RERANK_URL）"}
    WIDE -->|"是"| SETK["wideK = max(k, RERANK_CANDIDATE_K)=15"]
    WIDE -->|"否"| SETK2["wideK = k = 5（不重排就不宽召）"]

    SETK --> AUG{"QUERY_AUGMENT_ENABLED？"}
    SETK2 --> AUG
    AUG -->|"开（默认关）"| QRY["augmentQuery：planModel 结构化输出 1~5 条改写<br/>专名锁死 · 去重 · 原问题固定第 0 位"]
    AUG -->|"关"| QRY0["queries = [原问题]（与改造前逐字一致）"]
    QRY --> LOOP
    QRY0 --> LOOP

    subgraph LOOP["对每条问句【串行】循环（DashScope 免费档 QPS，禁止并发）"]
        direction TB
        D["稠密路：embedQuery（1024 维）→ Milvus COSINE top-wideK<br/>打 channel=dense 标记"]
        S["稀疏路：sparseRecall(q, wideK)<br/>ES BM25 或进程内 BM25（图6），channel=sparse"]
    end

    LOOP --> FUSE["rrfFuse：score = Σ 1/(60+rank)<br/>稠密列表必须排在稀疏列表之前<br/>同 id 保留首次出现（=保留 COSINE 对象）<br/>截断到 wideK=15"]
    FUSE --> SCORE["topScore = 稠密路全部候选的最高 COSINE<br/>（供 0.55 阈值，不掺任何其他分）"]
    SCORE --> RR{"重排器存在？"}
    RR -->|"是"| RERANK["DashscopeRerank.compressDocuments<br/>候选 15 条 cross-encoder 精排 → 保留 topN=5<br/>挂 rerankScore"]
    RR -->|"否"| PASS["直接取候选前 k 条"]
    RERANK -->|"成功"| OUT
    RERANK -->|"失败"| FALLBACK["告警 + 降级：COSINE 顺序前 k 条"]
    PASS --> OUT(["返回 {docs, topScore, reranked}"])
    FALLBACK --> OUT

    classDef newn fill:#7c2d12,stroke:#fb923c,color:#ffe8d6
    classDef keep fill:#0f2f26,stroke:#34d399,color:#d9fff1
    classDef dia fill:#e0e7ff,stroke:#818cf8,color:#312e81
    classDef se fill:#14532d,stroke:#22c55e,color:#eafff0
    class QRY,FUSE,RERANK,S newn
    class D keep
    class WIDE,AUG,RR dia
    class IN,OUT se
```

**关键决策与原因**

- **宽召回只在有重排时打开**：没有重排器却取 15 条，多出的 10 条没人用，纯浪费。
- **每条问句 × 每条通道各取满 wideK，不做预算拆分**：参考实现的 `kEach=ceil(K/n)` 会在「同通道同义问句结果高度重叠」时把候选稀释（实测 12 → 6），故弃用。
- **RRF 只认名次不认分**：天然解决「COSINE ∈ [0,1] 与 BM25 无上界（实测 33.24）不可比」的问题，k=60。
- **稠密路排在稀疏路之前是语义而非风格**：rrfFuse 对同 id 保留首个对象，排前面才能保证跨通道重复命中的片段带着 COSINE 分流出，后续 0.55 阈值和前端分数显示才成立。
- **三层降级全部静默**：扩展失败 → 单路；稀疏失败 → 空数组（纯向量）；重排失败 → COSINE 前 k。任何一层挂掉，问答链路不断。
- **消费端去重 [mergeUnique](src/ragGraph.mjs#L339-L361)**：跨轮检索同 id 去重；跨通道同 id 一律留稠密那条；同通道留高分。避免重复片段浪费 prompt、诱导 LLM 重复作答。

---

## 图 6 · 稀疏路后端选择与降级决策（SPARSE_BACKEND）

```mermaid
flowchart TD
    CALL["sparseRecall(q, 15)<br/>每次调用时 resolveConfig() 读 env<br/>（不在模块顶层读，避免早于 dotenv.config）"] --> CHK{"SPARSE_BACKEND"}

    CHK -->|"none"| OFF["返回 []<br/>= 改造前纯向量"]
    CHK -->|"es（强制）"| ESQ{"配了 ES_NODE？"}
    CHK -->|"memory（强制）"| MEM
    CHK -->|"auto（默认）"| AUTO{"配了 ES_NODE？"}

    ESQ -->|"否"| OFF
    ESQ -->|"是"| ESCALL["查 ES：multi_match(best_fields)<br/>写侧 ik_max_word / 查侧 ik_smart<br/>超时 3s · maxRetries=0"]
    AUTO -->|"是"| ESCALL
    AUTO -->|"否"| MEM["进程内 BM25<br/>启动预热构建（约 2.4s）<br/>11977 条 · bigram 中文分词<br/>k1=1.2 · b=0.75 · 单例 promise"]

    ESCALL -->|"成功"| OK(["channel=sparse 片段"])
    ESCALL -->|"失败"| AUTOCK{"backend=auto？"}
    AUTOCK -->|"是：降级"| MEM
    AUTOCK -->|"否：强制语义不降级"| EMPTY["返回 []"]
    MEM -->|"任何异常"| EMPTY
    MEM --> OK

    classDef es fill:#1e3a8a,stroke:#60a5fa,color:#eff6ff
    classDef mem fill:#7c2d12,stroke:#fb923c,color:#ffe8d6
    classDef off fill:#374151,stroke:#9ca3af,color:#f9fafb
    class ESCALL es
    class MEM mem
    class OFF,EMPTY off
```

**为什么是这套设计**

- **线上 ECS 只有 1.6GiB 内存且 `vm.max_map_count=65530`（ES8 要求 ≥262144），跑不起 ES** → 默认 `auto` 且不注入 `ES_NODE` 时自动落进程内 BM25；本地开发用 `docker-compose.es.yml` 起 ES 8.17 + analysis-ik。
- **语料不查 Milvus 而从 EPUB 重算**（[sparseCorpus.mjs](src/rag/sparseCorpus.mjs)）：Milvus 分页取数受 gRPC 4MB 限制只能取回 10970 个唯一 id，比实际 11977 条丢约 1007 条；直接按与灌库相同的参数（CHUNK_SIZE=500 / OVERLAP=50 / 章节 <100 字跳过 / id=`1_章号_切片号`）重算，保证与 Milvus 的 id 体系对齐。
- **ES 客户端 `maxRetries=0`**：ES 挂了要 3 秒内快速失败走降级，不能把问答拖住。
- **纯 JS bigram 分词**：连续中文切滑动二元组、ASCII 切整词小写；不引 jieba（node-gyp 原生编译在 Windows/服务器上都是风险）。

---

## 图 7 · 数据摄入：两条离线链路

```mermaid
flowchart LR
    EPUB["吞噬星空.epub"]

    subgraph A["链路 A：稠密索引（npm run ingest → src/main.mjs）"]
        direction TB
        A1["EPubLoader(splitChapters)<br/>按章生成 Document"]
        A2["过滤章节正文 &lt;100 字<br/>（34 个插图页跳过）"]
        A3["RecursiveCharacterTextSplitter<br/>chunk=500 · overlap=50"]
        A4["逐条 embedding（串行，避 QPS 限流）<br/>text-embedding-v3 · 1024 维"]
        A5["插入 Milvus ebook8<br/>id = 1_章号_切片号<br/>字段：book_id/book_name/chapter_num/index/content/vector"]
        A1 --> A2 --> A3 --> A4 --> A5
    end

    subgraph B["链路 B：稀疏索引（npm run sync:es → src/syncEsIndex.mjs）"]
        direction TB
        B1["sparseCorpus.loadSparseCorpus()<br/>同样的 EPUB + 同样的切分参数<br/>重算出 11977 条（1523 章）"]
        B2{"ES 装了 analysis-ik？"}
        B3["建索引：content 用 ik_max_word<br/>（失败回落内置 cjk 分词器）"]
        B4["bulk 每批 500 写入<br/>索引名 tsxk_starry_sky<br/>完成后 refresh + count 自检"]
        B1 --> B2 --> B3 --> B4
    end

    subgraph C["链路 C：进程内 BM25（无需脚本，启动自动构建）"]
        C1["同一 11977 条语料<br/>bigram 建倒排索引（常驻内存）"]
    end

    EPUB --> A1
    EPUB --> B1
    B1 -.->|"复用"| C1

    A5 --> QUERY_ONLINE["在线问答：稠密路"]
    B4 --> QUERY_ONLINE2["在线问答：稀疏路 ES 后端"]
    C1 --> QUERY_ONLINE3["在线问答：稀疏路 memory 后端"]

    classDef ingest fill:#0f2f26,stroke:#34d399,color:#d9fff1
    classDef online fill:#14532d,stroke:#22c55e,color:#eafff0
    class A1,A2,A3,A4,A5,B1,B2,B3,B4,C1 ingest
    class QUERY_ONLINE,QUERY_ONLINE2,QUERY_ONLINE3 online
```

**核对过的数字**

- Milvus 侧：集合 `ebook8`，索引 IVF_FLAT（nlist=1024）+ COSINE；Milvus `count(*)` 为 12062（历史灌库批次差异）。
- 稀疏侧：EPUB 重算 **11977 切片 / 1523 章 / 跳过 34 插图页**；`npm run sync:es` 写入 11977 条、索引实查 11977；进程内 BM25 top 分实测 33.24。
- 两条链路的切分参数和 id 规则刻意保持一致——RRF 融合时稠密/稀疏命中的同一段文字必须是同一个 id，融合才有意义。

---

## 图 8 · 对话记忆与落库：滑窗 + 滑动摘要

```mermaid
flowchart TD
    subgraph MSG["messages 表（按 id 递增）"]
        direction LR
        OLD["旧消息 …"] --> ZONE1["(0, summary_upto_id]<br/>已压进摘要"]
        ZONE1 --> ZONE2["(upto_id, windowStartId)<br/>已滑出窗口·待摘要"]
        ZONE2 --> ZONE3["最近 8 条 = 滑窗<br/>每次问答整体带入 context"]
        ZONE3 --> NEW["新消息"]
    end

    REQ["新一轮问答开始"] --> READ["getMemoryState 一次查齐：<br/>conversations.summary/upto_id + 最近 8 条倒序取再反转 + COUNT 待摘要数"]
    READ --> CTX["context = 【历史摘要】+ 滑窗 8 条（每条截断 1800 字）"]
    CTX --> GRAPHRUN["送入图引擎（仅供指代消解）"]
    GRAPHRUN --> SAVE["流结束后落库 user/assistant 两条消息"]
    SAVE --> TRIG{"待摘要 ≥ 12 条？<br/>(MEMORY_SUMMARY_TRIGGER)"}
    TRIG -->|"否"| DONE1["什么都不做"]
    TRIG -->|"是（且该会话无摘要任务在跑）"| SUM["summarizeHistory（planModel, temp=0）<br/>旧摘要 + 待摘要消息融合重写<br/>单条截断 800 · 总输入 ≤6000 · 输出 ≤300 字"]
    SUM --> UPSERT["saveConversationSummary：<br/>更新 summary，推进 summary_upto_id"]
    UPSERT --> DONE2["下一轮起区间整体前移"]

    classDef zone fill:#1f2937,stroke:#6b7280,color:#f9fafb
    classDef hot fill:#7c2d12,stroke:#fb923c,color:#ffe8d6
    class ZONE1,ZONE2,ZONE3 zone
    class SUM,UPSERT hot
```

**设计意图**

- **滑窗保「最近细节」精确，摘要保「远期脉络」不丢**：三段区间靠 `summary_upto_id` 严格不重叠，不会重复压缩同一批消息。
- **摘要是异步旁路**：`maintainSummary` 在响应结束后才触发，用进程内 Set 防止同会话并发重复压缩；失败只记日志，记忆自动回退为纯滑窗，问答无感。
- **落库三列**：messages.content 存全文，sources 存检索来源 JSON（chapter/score/content，网页还带 url/siteName/siteIcon/dateLastCrawled），thinking 存 `{lines:[...], seconds}`——历史会话回放时思考面板可完整复现。

---

## 图 9 · 部署拓扑（docker-compose）

```mermaid
flowchart TB
    subgraph HOST["服务器（线上 ECS）"]
        subgraph COMPOSE["docker-compose.yml（version 3.8）"]
            NGINX["nginx:alpine<br/>80/443 入口 · 反向代理 · TLS<br/>挂载 deploy/nginx.conf + certs"]
            APP["tsxkrag-app:latest（Node）<br/>expose 3000（不对公网）<br/>启动：initRagGraph 后才 listen"]
            MYSQL["mysql:8.0<br/>mysql-data 卷持久化<br/>首次启动自动执行 deploy/schema.sql<br/>healthcheck 探活"]
            NGINX --> APP --> MYSQL
        end
        ESBOX["docker-compose.es.yml（仅本地/高配机）<br/>ES 8.17.3 + 首次启动装 analysis-ik 8.17.3<br/>-Xms/Xmx 512m · 端口 9200"]
    end

    USER(["用户浏览器"]) -->|"HTTPS"| NGINX
    APP -.->|"公网 HTTPS"| ZILLIZ["Zilliz Cloud（Milvus 托管）"]
    APP -.->|"公网 HTTPS"| DASH2["DashScope（模型/embedding）"]
    APP -.->|"公网 HTTPS"| BOCHA2["博查搜索"]
    APP -.->|"auto + ES_NODE 时"| ESBOX

    classDef box fill:#0f2f26,stroke:#34d399,color:#d9fff1
    classDef ext fill:#1f2937,stroke:#6b7280,color:#f9fafb
    classDef es fill:#1e3a8a,stroke:#60a5fa,color:#eff6ff
    class NGINX,APP,MYSQL box
    class ZILLIZ,DASH2,BOCHA2 ext
    class ESBOX es
```

**部署相关事实（均来自仓库文件）**

- 编排里 **app 依赖 mysql 健康检查通过才启动**；镜像本地构建后 `docker save → scp → docker load` 上线（服务器拉镜像不稳定）。
- **当前 docker-compose.yml 的 app 环境变量清单里没有注入 `RERANK_*` / `SPARSE_*` / `ES_NODE`**：容器内将按代码默认值运行——重排因无 `RERANK_URL` 自动关闭（启动告警），稀疏路为 `auto` 且无 ES 地址 → 走进程内 BM25（常驻约 177MB 堆）。若 ECS 内存吃紧需在 compose 显式加 `SPARSE_BACKEND=none`；要在容器里开重排，则需补 `RERANK_URL`、`RERANK_MODEL`。
- 环境变量分两类：`.env` 本地开发用（不入库，.gitignore 已忽略）；容器环境由 compose 的 `environment:` 显式枚举。
- 端口统一 `process.env.PORT || 3000`，适配平台分配。

---

## 附 · 一张表记住全系统的「数字契约」

| 位置 | 参数 | 值 | 出处 |
|---|---|---|---|
| 检索 | 每轮最终条数 k | 5 | server.js |
| 检索 | 检索轮数上限 | 生产 5 / 评测 3 / 图默认 3 | server.js · eval · ragGraph |
| 检索 | 子问题数量 | 1~8 | DecomposeSchema |
| 检索 | 宽召回候选 RERANK_CANDIDATE_K | 15 | .env / 默认值 |
| 融合 | RRF k | 60 | hybridRetrieval.mjs |
| 阈值 | 低分联网 lastTopScore | < 0.55 | ragGraph 常量 |
| 重排 | 保留 topN | 跟随 k=5 | ragGraph |
| 稀疏 | BM25 参数 | k1=1.2，b=0.75 | bm25Index.mjs |
| 稀疏 | ES 超时 / 批量 | 3000ms / 500 条 | sparseRecall / syncEsIndex |
| 切分 | chunk / overlap / 最小章节 | 500 / 50 / 100 字 | main.mjs · sparseCorpus.mjs |
| 向量 | 维度 / 度量 / 索引 | 1024 / COSINE / IVF_FLAT nlist=1024 | main.mjs |
| 语料 | 切片数 / 章节数 | 11977 / 1523 | 实测（docs/04） |
| 记忆 | 滑窗 / 摘要触发 / 摘要上限 | 8 条 / 12 条待摘要 / 300 字 | chatModel · ragGraph |
| 鉴权 | 密码哈希 / token 有效期 | bcrypt cost=10 / 2h | auth 路由 · jwt.js |
| 联网 | 每次问答最多次数 / 每轮条数 | 1 次 / 8 条 | webSearched 闸门 · webSearchNode |
| 流式 | 事件顺序 | meta→think*→sources→token*→done | server.js · ragApi.js |
