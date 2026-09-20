// ==================== Agentic RAG 图引擎（LangGraph） ====================
// 职责：把「路由 → 拆解 → 多跳检索 → 规划 → 生成（+博查联网兜底）」的 agentic RAG 流程封装成状态图
// server.js 只做胶水：HTTP 鉴权 / 会话落库 / 把流式 sink 注入图执行
// 检索复用 @zilliz/milvus2-sdk-node 直连（与原 server.js 一致，避免 vectorstore 封装的索引参数不匹配问题）
import { z } from 'zod'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai'
import { SystemMessage } from '@langchain/core/messages'
import { MilvusClient, MetricType } from '@zilliz/milvus2-sdk-node'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// .env 按本模块位置解析（即项目根目录），不依赖启动时的工作目录
// （否则在 src/ 下执行 node server.js 时，dotenv 会去找 src/.env 而读不到根目录配置）
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

// ===== RAG 组件初始化（与原 server.js 保持一致的配置） =====
const COLLECTION_NAME = 'ebook8'
const VECTOR_DIM = 1024
const TOP_K = 5

// 生成模型：temperature 0.7（与原 /api/chat 一致，平衡忠实与流畅）
const model = new ChatOpenAI({
  temperature: 0.7,
  model: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
})

// 规划类模型：路由/拆解/规划是结构化输出决策，temperature 0 保证稳定
// 决策任务比生成简单，用更快的 PLAN_MODEL_NAME（如 qwen-turbo）提速；未配置则回落主模型
const planModel = new ChatOpenAI({
  temperature: 0,
  model: process.env.PLAN_MODEL_NAME || process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
})

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.EMBEDDINGS_MODEL_NAME,
  configuration: { baseURL: process.env.OPENAI_BASE_URL },
  dimensions: VECTOR_DIM,
})

const client = new MilvusClient({
  address: process.env.MILVUS_ADDRESS,
  token: process.env.MILVUS_TOKEN,
})

// 启动时调用一次：连接 Milvus 并加载集合到内存
export async function initRagGraph() {
  await client.connect()
  console.log('Milvus 连接成功')
  try {
    await client.loadCollection({ collection_name: COLLECTION_NAME })
    console.log('集合加载完成')
  } catch (e) {
    console.log('集合已在加载状态')
  }
}

// ===== 向量检索（复用原 server.js 的 retrieveRelevantContent） =====
export async function retrieveRelevantContent(question, k = TOP_K) {
  try {
    const queryVector = await embeddings.embedQuery(question)
    const searchResult = await client.search({
      collection_name: COLLECTION_NAME,
      vectors: [queryVector],
      limit: k,
      metric_type: MetricType.COSINE,
      output_fields: ['id', 'content', 'book_id', 'chapter_num'],
    })
    return (searchResult.results || []).map((item) => ({
      score: item.score,
      content: item.content,
      id: item.id ?? 'unknown',
      book_id: item.book_id ?? '未知',
      chapter_num: item.chapter_num ?? '未知',
    }))
  } catch (error) {
    console.error('检索内容时出错：', error.message)
    return []
  }
}

// ===== 图状态定义 =====
const GraphState = Annotation.Root({
  question: Annotation,          // 用户原始问题
  conversationContext: Annotation, // 有界的持久化短期记忆，用于指代消解
  k: Annotation,                 // 每轮检索条数
  strategy: Annotation,          // 路由结果：simple / complex
  routeReason: Annotation,       // 路由理由
  subQuestions: Annotation,      // 拆解出的有序子问题
  nextSubIdx: Annotation,        // 当前待检索的子问题下标
  currentQuery: Annotation,      // 当前正在检索的子问题
  retrievalCount: Annotation,    // 已检索轮数
  maxRetrievalCount: Annotation, // 检索轮数上限
  planedNext: Annotation,        // 规划器决策：retrieve / web_search / generate
  planedWebQuery: Annotation,    // 规划器生成的联网搜索查询句（仅 web_search 决策时填写）
  documents: Annotation,         // 累积（去重后）的库内检索结果
  webDocs: Annotation,           // 博查联网搜索结果（独立保存，不混入库内 documents 以免污染分数）
  webSearched: Annotation,       // 是否已联网搜索过（防循环闸门：每次问答最多联网一次）
  lastTopScore: Annotation,      // 最近一轮库内检索的最高相似度（低分联网兜底的判断依据）
  generation: Annotation,        // 最终回答
})

// ===== 结构化输出 Schema（zod 约束 LLM 输出） =====
const RouteSchema = z.object({
  // simple: 闲聊常识；complex: 小说情节（查知识库）；web: 库外资讯（联网兜底）
  strategy: z.enum(['simple', 'complex', 'web']),
  reason: z.string(),
})

const DecomposeSchema = z.object({
  sub_questions: z.array(z.string()).min(1).max(8),
  reason: z.string(),
})

const NextStepSchema = z.object({
  nextAction: z.enum(['generate', 'retrieve', 'web_search']),
  webQuery: z.string().optional(), // 仅 web_search 决策时输出：适合互联网搜索的完整中文查询句
  reason: z.string(),
})

// 把图内 documents 转成前端/落库用的 sources 结构（与原 /api/chat 协议一致）
const formatSources = (docs) =>
  (docs || []).map((d) => ({
    chapter: d.chapter_num,
    score: Number(d.score).toFixed(4),
    content: d.content,
  }))

// 把联网搜索结果转成 sources 同构结构（url/siteName 供前端渲染可点击来源；导出供 server.js 落库合并用）
// 博查字段全量透传：siteIcon（网站图标）/ dateLastCrawled（发布时间）随 sources 一并落库，前端可按需使用
export const formatWebSources = (docs) =>
  (docs || []).map((d, i) => ({
    chapter: `网络资料${i + 1}`,
    score: '-',
    content: d.content,
    url: d.url,
    siteName: d.siteName,
    siteIcon: d.siteIcon,
    dateLastCrawled: d.dateLastCrawled,
  }))

// ===== 节点 1：路由（判断是否需要检索） =====
const routeQuestionNode = async (state, config) => {
  console.log('___ROUTE-QUESTION___')
  const router = planModel.withStructuredOutput(RouteSchema)
  const route = await router.invoke(`
  你是问答路由器，请判断用户问题属于哪一类。

  规则：
  - simple: 常识问答、简短定义、无需特定小说细节即可回答。
  - complex: 需要《吞噬星空》具体情节、人物关系、章节事实、原文细节或证据支持。
  - web: 与《吞噬星空》小说情节无关的库外资讯——作者动态、动画/电视剧更新、跨作品比较、现实资讯等，知识库不可能有答案，需要联网搜索。

  最近对话上下文（仅用于理解指代，不可作为小说事实依据）：
  ${state.conversationContext || '（无）'}

  用户问题：${state.question}
  `)
  console.log(`路由策略：${route.strategy} ${route.reason}`)
  // 思考过程推流：让前端实时看到路由判定（增加等待时的掌控感）
  const routeThink = {
    simple: '判定为简单问题：无需检索知识库，直接回答',
    complex: '判定为小说相关复杂问题：需要检索知识库、多跳取证后再回答',
    web: '判定为库外资讯问题：知识库没有相关内容，将联网搜索补充',
  }
  config?.configurable?.sink?.onThink?.(routeThink[route.strategy] ?? routeThink.complex)
  return {
    strategy: route.strategy,
    routeReason: route.reason,
    retrievalCount: 0,
    webSearched: false,
    webDocs: [],
    documents: [],
    subQuestions: [],
    nextSubIdx: 0,
    currentQuery: '',
    // 注意：字段名必须与 GraphState.maxRetrievalCount 一致（原稿误写成 maxRetrievals）
    maxRetrievalCount: state.maxRetrievalCount ?? 3,
  }
}

// ===== 节点 2：直接回答（simple 路径，不检索） =====
const directAnswerNode = async (state, config) => {
  console.log('----DIRECT_ANSWER----')
  const sink = config?.configurable?.sink // HTTP 层注入的流式回调
  let generation = ''
  const stream = await model.stream(`你是一个中文回答助手，请简洁回答问题。
最近对话上下文（仅用于理解指代）：
${state.conversationContext || '（无）'}
问题：${state.question}`)
  for await (const chunk of stream) {
    const text = typeof chunk.content === 'string' ? chunk.content : ''
    if (!text) continue
    generation += text
    sink?.onToken?.(text) // 逐 token 推给前端
  }
  return { generation }
}

// ===== 节点 3：子问题拆解（complex 路径） =====
const decomposeQuestionNode = async (state, config) => {
  console.log('----DECOMPOSE_QUESTION----')
  const decomposer = planModel.withStructuredOutput(DecomposeSchema)
  const out = await decomposer.invoke(`
    你是《吞噬星空》多跳问答的【子问题拆解器】。
    用户原始问题：
    ${state.question}

    最近对话上下文（仅用于消解指代，不要把它当作小说事实）：
    ${state.conversationContext || '（无）'}

    任务：将问题拆成**有序**子问题列表 sub_questions, 用于**依次向量检索**。要求：
    1. 链式推理、多层关系、因果先后的问题，必须拆成多条；单跳即可答的也可只输出1条。
    2. 每条子问题必须是**可独立检索**的完整中文问句，**禁止**使用「他/她/此人/上文」等指代；要写全人物名与事件名。
    3. 【结论层优先排序】「为什么/评价/差距/对比」类问题，结论层子问题（最终境界、后期评价、原著对比依据等）必须排在子问题序列的**前半部分**（前 1～3 位），背景层子问题放后面。这样即使检索轮数有限，也能先查到最关键的结论层证据。
    4. 不要把整句原题原样复制成唯一一条（除非确实无法拆分）；不要拆成过碎的关键词列表。
    5. 输出 1～8 条即可。

    请输出 sub_questions 与简短 reason。
  `)

  const subQuestions = out.sub_questions.map((s) => s.trim()).filter(Boolean)
  if (subQuestions.length === 0) {
    throw new Error('decompose_question: sub_questions 为空')
  }
  console.log(`拆解${subQuestions.length}条子问题：${out.reason}`)
  subQuestions.forEach((q, i) => console.log(`  [${i + 1}] ${q}`))
  // 思考过程推流：把拆解结果实时给前端看
  const sink = config?.configurable?.sink
  sink?.onThink?.(`问题较复杂，已拆解为 ${subQuestions.length} 个子问题，依次检索`)
  subQuestions.forEach((q, i) => sink?.onThink?.(`子问题${i + 1}：${q}`))
  return {
    subQuestions,
    nextSubIdx: 0,
    currentQuery: subQuestions[0],
  }
}

// ===== 多跳检索去重：同 id 文档保留更高分的一条 =====
const mergeUnique = (existingDocs, newDocs) => {
  const map = new Map() // ES6 HashMap：按文档 id 去重
  for (const d of [...existingDocs, ...newDocs]) {
    const key = String(d.id)
    const prev = map.get(key)
    if (!prev || Number(d.score) > Number(prev.score)) {
      map.set(key, d)
    }
  }
  return [...map.values()]
}

// ===== 节点 4：检索单轮（每次消费一条子问题） =====
const retrieveNode = async (state, config) => {
  const sink = config?.configurable?.sink
  const subs = state.subQuestions ?? []
  const idx = state.nextSubIdx ?? 0
  const q = subs[idx]?.trim() // 当前这一轮的子问题
  if (!q) {
    throw new Error(`retrieve: 子问题下标 ${idx} 无有效文本（共 ${subs.length} 条子问题）`)
  }

  const round = state.retrievalCount + 1
  console.log(`----第${round}轮检索，子问题 ${idx + 1}/${subs.length}----`)
  console.log(`查询：${q}`)
  // 思考过程推流：本轮检索意图
  sink?.onThink?.(`第${round}轮检索：「${q}」`)

  const newDocs = await retrieveRelevantContent(q, state.k)
  // 多轮检索可能重复命中同一片段 → 去重，避免浪费 prompt、诱导 LLM 重复作答
  const merged = mergeUnique(state.documents ?? [], newDocs)
  if (newDocs.length === 0) {
    console.log('本轮未命中相关文档')
    sink?.onThink?.('→ 本轮未命中相关片段')
  } else {
    console.log(`本轮命中${newDocs.length}条，累计去重后${merged.length}条`)
    newDocs.forEach((item, i) => {
      console.log(`  [R${i + 1}] score=${Number(item.score).toFixed(4)} 第${item.chapter_num}章`)
    })
    // 思考过程推流：命中概况（章节号去重取前 3 个）
    const chapters = [...new Set(newDocs.map(d => d.chapter_num))].slice(0, 3).join('、')
    sink?.onThink?.(`→ 命中${newDocs.length}条片段（第${chapters}章等），累计去重${merged.length}条`)
  }
  // 若本轮检索后已无子问题可查 / 已达轮数上限，规划器将被条件边跳过（必然 generate，省一次 LLM 调用），
  // 这里直接补上"开始组织答案"的思考行，保证叙事完整
  const remainingAfter = subs.length - (idx + 1)
  if (remainingAfter <= 0) {
    sink?.onThink?.(`评估：子问题已全部检索完，基于累计${merged.length}条片段组织答案`)
  } else if (round >= (state.maxRetrievalCount ?? 3)) {
    sink?.onThink?.(`评估：已达检索轮数上限（${state.maxRetrievalCount}轮），基于累计${merged.length}条片段组织答案`)
  }
  // 记录本轮最高相似度：检索完成后若仍低于阈值，说明库内可能没有该主题（供条件边联网兜底判断）
  const topScore = newDocs.length ? Math.max(...newDocs.map((d) => Number(d.score))) : 0
  return {
    documents: merged,
    retrievalCount: round,
    nextSubIdx: idx + 1,
    currentQuery: q,
    lastTopScore: topScore,
  }
}

// ===== 节点 5：规划（决定继续检索还是生成） =====
const planNextStepNode = async (state, config) => {
  console.log('----PLAN_NEXT_STEP----')
  const subs = state.subQuestions ?? []
  const nextIdx = state.nextSubIdx ?? 0
  const remaining = subs.length - nextIdx

  const subList = subs.map((s, i) => `[${i + 1}] ${s} ${i < nextIdx ? '(已检索)' : i === nextIdx ? '(下一轮将检索，若选择继续)' : '(未检索)'}`).join('\n')

  const docStr = (state.documents ?? []).length === 0
    ? '(尚无检索结果)'
    : (state.documents ?? [])
        .slice(0, 6)
        .map((d, i) => `[${i + 1}] score=${Number(d.score).toFixed(4)} 第${d.chapter_num}章 ${d.content.slice(0, 200)}`)
        .join('\n\n')

  const prompt = `你是多跳 RAG 规划器。检索查询已由前置步骤拆解为**有序子问题**。
若需要继续检索，下一轮将自动使用 [下一条子问题] 做向量检索，你**不要**自拟新的检索句。
用户原始问题：${state.question}
最近对话上下文（仅用于理解指代）：
${state.conversationContext || '（无）'}
子问题序列：
${subList || '无'}

已检索轮次: ${state.retrievalCount}; 剩余未检索子问题条数: ${remaining}
最大检索轮数上限: ${state.maxRetrievalCount}

已召回文档摘要（全部来自本地知识库）:
${docStr}

请判断下一步:
1) 已有足够信息回答用户原始问题 -> nextAction = generate
2) 仍缺关键事实、且仍存在未检索的子问题、且未超过轮数上限 -> nextAction = retrieve
3) 库内片段与问题相关性普遍很低（score<0.6）或缺失的是库外资讯（作者动态/动画更新/跨作品等知识库不可能有的内容）-> nextAction = web_search，并输出 webQuery（适合互联网搜索的完整中文查询句）
注意：仅当问题主题明显在《吞噬星空》知识库之外时才选 web_search，小说情节问题永远优先检索库内子问题。`

  const planner = planModel.withStructuredOutput(NextStepSchema)
  const { nextAction, reason, webQuery } = await planner.invoke(prompt)

  // 兜底硬规则（不信任 LLM 一定遵守）
  let finalNext = nextAction
  if (state.webSearched && finalNext === 'web_search') finalNext = 'generate' // 只允许联网一次
  // 防御：剩余子问题为 0 / 轮数到顶时本节点通常不会被调用（afterRetrieve 已直接分流），仅拦 retrieve
  if (remaining <= 0 && finalNext === 'retrieve') finalNext = 'generate'
  if (state.retrievalCount >= state.maxRetrievalCount && finalNext === 'retrieve') finalNext = 'generate'
  console.log(`[决策] nextAction=${finalNext}（LLM建议: ${nextAction}）原因: ${reason}`)
  // 思考过程推流：规划决策
  const planThink = {
    retrieve: '评估：关键事实仍缺失，继续检索下一子问题',
    web_search: '评估：库内证据不足，联网搜索补充',
  }
  config?.configurable?.sink?.onThink?.(
    planThink[finalNext] ?? `评估：已累计${(state.documents ?? []).length}条片段，信息足够，开始组织答案`
  )
  return {
    planedNext: finalNext,
    planedWebQuery: finalNext === 'web_search' ? (webQuery ?? '').trim() : '',
  }
}

// 条件边：规划器决策写回 state 后由这里读取（不能读 strategy，那是路由的字段）
const afterPlan = (state) => {
  if (state.planedNext === 'retrieve') return 'retrieve'
  if (state.planedNext === 'web_search') return 'web_search'
  return 'generate'
}

// 条件边：检索后若已无未检索子问题、或已达轮数上限 → 跳过规划器直接分流（省一次 LLM 调用 3~6s）
// 联网兜底：检索完成但库内最高相似度 < 0.55（多为库外主题）且尚未联网过 → 联网补充搜索
const LOW_SCORE_THRESHOLD = 0.55 // 《吞噬星空》库内正常命中 0.63~0.77，库外主题实测 0.4~0.55
const afterRetrieve = (state) => {
  const remaining = (state.subQuestions ?? []).length - (state.nextSubIdx ?? 0)
  const budgetHit = (state.retrievalCount ?? 0) >= (state.maxRetrievalCount ?? 3)
  const done = remaining <= 0 || budgetHit
  if (!done) return 'plan'
  if (!state.webSearched && (state.lastTopScore ?? 0) < LOW_SCORE_THRESHOLD) return 'web_search'
  return 'generate'
}

// ===== 节点 6：RAG 生成（流式输出到 sink） =====
const generateNode = async (state, config) => {
  console.log('----RAG_GENERATE----')
  const sink = config?.configurable?.sink
  const docs = state.documents ?? []   // 库内片段
  const webDocs = state.webDocs ?? []  // 联网资料（可能为空）

  // 库内、联网都一无所获 → 与原 /api/chat 一致的兜底文案
  if (docs.length === 0 && webDocs.length === 0) {
    const fallback = '抱歉，没有在《吞噬星空》中找到相关内容。'
    sink?.onThink?.('知识库与联网搜索均未找到相关资料，将如实告知用户')
    sink?.onToken?.(fallback)
    return { generation: fallback }
  }

  // 上下文分两块组装：库内片段与联网资料分开标注，来源清晰、便于 LLM 区分引用
  const localContext = docs
    .map((item, i) => `[片段${i + 1}] 章节号:${item.chapter_num}, 内容:${item.content}`)
    .join('\n\n----\n\n')
  // 联网资料格式化：与教学版 bochaWebSearch 的 7 字段文本块一致（引用/标题/URL/摘要/网站名称/网站图标/发布时间）
  const webContext = webDocs
    .map((item, i) => `[网页${i + 1}]
引用: ${i + 1}
标题：${item.title}
URL: ${item.url}
摘要：${item.summary ?? ''}
网站名称：${item.siteName}
网站图标：${item.siteIcon ?? ''}
发布时间：${item.dateLastCrawled ?? ''}`)
    .join('\n\n----\n\n')
  const contextBlock = [
    localContext ? `【本地知识库片段】\n${localContext}` : '',
    webContext ? `【联网补充资料】\n${webContext}` : '',
  ].filter(Boolean).join('\n\n====\n\n')

  const prompt = `你是一个专业的《吞噬星空》小说助手。
基于下方上下文回答问题，用准确、详细的语言。
${contextBlock}

用户问题：${state.question}
最近对话上下文（仅用于理解指代，不作为事实依据）：
${state.conversationContext || '（无）'}

回答要求：
1. 优先综合多个片段回答问题；只有片段与问题**完全无关**时才告知无法回答。
2. 部分回答策略：如果片段只能覆盖问题的**一部分**，先基于片段把能答的部分答好（说明依据的章节），再明确指出哪些部分片段未覆盖，**不要**因为个别部分缺失就整体拒答。
3. 「为什么/评价/对比」类问题，允许基于片段中的事实（机缘、传承、境界、战绩）做合理分析推断，但需注明这是基于检索片段的推断。
4. 小说情节以【本地知识库片段】为准；引用【联网补充资料】时需注明来源网站，回答库外资讯类问题（作者动态、动画更新等）时给出可核对的来源链接。
5. 回答要准确，符合小说情节和人物设定。不要输出表情符号。

ai助手的回答：`

  // sources 事件领先于正文发送——前端先渲染来源区，再流式填正文（库内 + 联网合并推送）
  sink?.onSources?.([...formatSources(docs), ...formatWebSources(webDocs)])
  let generation = ''
  const stream = await model.stream([new SystemMessage(prompt)])
  for await (const chunk of stream) {
    const text = typeof chunk.content === 'string' ? chunk.content : JSON.stringify(chunk.content)
    if (!text) continue
    generation += text
    sink?.onToken?.(text)
  }
  return { generation }
}

// ===== 节点 7：博查联网搜索（web 兜底） =====
// 触发来源：① 路由判定为库外资讯（strategy=web）② 检索完成后库内低分兜底 ③ 规划器判定库内没戏
// 结果独立存 webDocs（不混入库内 documents）；webSearched 闸门保证每次问答最多联网一次
const webSearchNode = async (state, config) => {
  console.log('----WEB_SEARCH----')
  const sink = config?.configurable?.sink
  // 查询句优先用规划器生成的联网查询；路由直达 / 低分兜底场景回退用户原始问题
  const query = (state.planedWebQuery ?? '').trim() || state.question
  const reason = state.strategy === 'web' ? '问题属于库外资讯' : '知识库证据不足'
  console.log(`联网查询（${reason}）：${query}`)
  sink?.onThink?.(`${reason}，联网搜索：「${query}」`)

  // 未配置 Key 时优雅降级：跳过联网照常回答，不让整条链路报错
  if (!process.env.BOCHA_API_KEY) {
    sink?.onThink?.('未配置博查API Key（BOCHA_API_KEY），跳过联网，基于现有资料回答')
    return { webSearched: true, webDocs: [] }
  }

  let webDocs = []
  try {
    webDocs = await bochaWebSearch(query, 8)
  } catch (error) {
    // 联网失败不阻断主流程：记日志、推思考行，降级为纯库内回答
    console.error('博查搜索失败：', error.message)
    sink?.onThink?.('联网搜索出错，跳过联网，基于现有资料回答')
  }
  sink?.onThink?.(
    webDocs.length
      ? `→ 搜到${webDocs.length}条网页资料，开始综合组织答案`
      : '→ 联网未找到相关资料，基于现有信息回答'
  )
  return { webSearched: true, webDocs }
}

// 博查 Web Search API 封装（独立函数，方便日后替换其他搜索服务）
// 文档：https://open.bochaai.com —— POST /v1/web-search，Bearer 鉴权
// 错误处理链与教学版对齐：网络错误 / 非 2xx / JSON 解析失败 三层各自抛出明确错误
async function bochaWebSearch(query, count = 8) {
  let response
  try {
    response = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.BOCHA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        freshness: 'noLimit', // 不限时间范围
        summary: true,        // 返回网页摘要，无需自己抓正文
        count,
      }),
    })
  } catch (error) {
    throw new Error(`搜索API 请求失败(网络错误): ${error.message}`)
  }
  // 非 2xx：先 text() 拿错误页文本再抛（避免对错误响应用 json() 解析失败）
  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`搜索API 请求失败，状态码:${response.status}, 错误信息：${errorText.slice(0, 200)}`)
  }
  let json
  try {
    json = await response.json()
  } catch (err) {
    throw new Error(`搜索结果解析失败：${err.message}`)
  }
  const webpages = json?.data?.webPages?.value ?? []
  if (!webpages.length) return []
  // 统一成与库内文档同构的结构（source:'web' 标记；content 组合标题+摘要）
  // 博查返回字段逐一全量保留，不再缺项：标题/URL/摘要/网站名称/网站图标/发布时间
  return webpages.map((page) => ({
    id: page.url,        // 用 URL 当唯一键
    score: 0,            // 联网结果无相似度概念，不参与库内分数比较
    content: `${page.name}\n${page.summary ?? ''}`.trim(),
    chapter_num: '',     // 前端按 source 渲染，不用章节号
    source: 'web',
    url: page.url,                               // URL: page.url
    title: page.name,                            // 标题：page.name
    summary: page.summary ?? '',                 // 摘要：page.summary（summary:true 时返回）
    siteName: page.siteName ?? '网络来源',        // 网站名称：page.siteName
    siteIcon: page.siteIcon ?? '',               // 网站图标：page.siteIcon
    dateLastCrawled: page.dateLastCrawled ?? '', // 发布时间：page.dateLastCrawled
  }))
}

// 路由条件边：simple → 直接回答；complex → 拆解；web → 联网兜底
const afterRoute = (state) => {
  if (state.strategy === 'simple') return 'direct_answer'
  if (state.strategy === 'web') return 'web_search'
  return 'decompose_question'
}

// ===== 建图 =====
// route → (simple)  direct_answer → END
//       → (complex) decompose → retrieve →（还有子问题且未到上限）plan ⇄ retrieve（多跳循环）
//                                        ├→（查完/达上限且库内证据足够） generate → END
//                                        └→（查完/达上限但库内低分，或规划器判定库内没戏） web_search → generate
//       → (web)     web_search → generate → END（联网兜底：每次问答最多联网一次）
const graph = new StateGraph(GraphState)
  .addNode('route_question', routeQuestionNode)
  .addNode('direct_answer', directAnswerNode)
  .addNode('decompose_question', decomposeQuestionNode)
  .addNode('retrieve', retrieveNode)
  .addNode('plan_next_step', planNextStepNode)
  .addNode('web_search', webSearchNode)
  .addNode('rag_generate', generateNode)
  .addEdge(START, 'route_question')
  .addConditionalEdges('route_question', afterRoute, {
    direct_answer: 'direct_answer',
    decompose_question: 'decompose_question',
    web_search: 'web_search',
  })
  .addEdge('decompose_question', 'retrieve')
  .addConditionalEdges('retrieve', afterRetrieve, {
    plan: 'plan_next_step',
    generate: 'rag_generate',
    web_search: 'web_search',
  })
  .addConditionalEdges('plan_next_step', afterPlan, {
    retrieve: 'retrieve',
    generate: 'rag_generate',
    web_search: 'web_search',
  })
  .addEdge('web_search', 'rag_generate')
  .addEdge('direct_answer', END)
  .addEdge('rag_generate', END)
  .compile()

/**
 * 对外唯一入口：跑一次完整 agentic RAG
 * @param {Object} opts
 * @param {string} opts.question 用户问题
 * @param {number} [opts.k] 每轮检索条数（默认 5）
 * @param {number} [opts.maxRetrievalCount] 检索轮数上限（默认 3）
 * @param {Object} [opts.sink] 流式回调 { onThink(text), onToken(text), onSources(sources) }，由 HTTP 层注入
 * @returns {Promise<Object>} 最终状态（含 generation / documents / strategy 等）
 */
export async function runAgenticRAG({ question, k = TOP_K, maxRetrievalCount = 3, conversationContext = '', sink }) {
  return graph.invoke(
    {
      question,
      conversationContext,
      k,
      maxRetrievalCount,
      strategy: '',
      routeReason: '',
      subQuestions: [],
      nextSubIdx: 0,
      currentQuery: '',
      retrievalCount: 0,
      planedNext: '',
      planedWebQuery: '',
      documents: [],
      webDocs: [],
      webSearched: false,
      lastTopScore: 0,
      generation: '',
    },
    { configurable: { sink } } // sink 走 LangGraph configurable 通道注入节点（并发安全，不用全局变量）
  )
}
