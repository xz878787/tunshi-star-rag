// ==================== Agentic RAG 图引擎（LangGraph） ====================
// 职责：把「路由 → 拆解 → 多跳检索 → 规划 → 生成」的 agentic RAG 流程封装成状态图
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
async function retrieveRelevantContent(question, k = TOP_K) {
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
  k: Annotation,                 // 每轮检索条数
  strategy: Annotation,          // 路由结果：simple / complex
  routeReason: Annotation,       // 路由理由
  subQuestions: Annotation,      // 拆解出的有序子问题
  nextSubIdx: Annotation,        // 当前待检索的子问题下标
  currentQuery: Annotation,      // 当前正在检索的子问题
  retrievalCount: Annotation,    // 已检索轮数
  maxRetrievalCount: Annotation, // 检索轮数上限
  planedNext: Annotation,        // 规划器决策：retrieve / generate
  documents: Annotation,         // 累积（去重后）的检索结果
  generation: Annotation,        // 最终回答
})

// ===== 结构化输出 Schema（zod 约束 LLM 输出） =====
const RouteSchema = z.object({
  strategy: z.enum(['simple', 'complex']),
  reason: z.string(),
})

const DecomposeSchema = z.object({
  sub_questions: z.array(z.string()).min(1).max(8),
  reason: z.string(),
})

const NextStepSchema = z.object({
  nextAction: z.enum(['generate', 'retrieve']),
  reason: z.string(),
})

// 把图内 documents 转成前端/落库用的 sources 结构（与原 /api/chat 协议一致）
const formatSources = (docs) =>
  (docs || []).map((d) => ({
    chapter: d.chapter_num,
    score: Number(d.score).toFixed(4),
    content: d.content,
  }))

// ===== 节点 1：路由（判断是否需要检索） =====
const routeQuestionNode = async (state, config) => {
  console.log('___ROUTE-QUESTION___')
  const router = planModel.withStructuredOutput(RouteSchema)
  const route = await router.invoke(`
  你是问答路由器，请判断用户问题是否需要外部检索。

  规则：
  - simple: 常识问答、简短定义、无需特定小说细节即可回答。
  - complex: 需要《吞噬星空》具体情节、人物关系、章节事实、原文细节或证据支持。

  用户问题：${state.question}
  `)
  console.log(`路由策略：${route.strategy} ${route.reason}`)
  // 思考过程推流：让前端实时看到路由判定（增加等待时的掌控感）
  config?.configurable?.sink?.onThink?.(
    route.strategy === 'simple'
      ? '判定为简单问题：无需检索知识库，直接回答'
      : '判定为小说相关复杂问题：需要检索知识库、多跳取证后再回答'
  )
  return {
    strategy: route.strategy,
    routeReason: route.reason,
    retrievalCount: 0,
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
  const stream = await model.stream(`你是一个中文回答助手, 请简洁回答问题。
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

    任务：将问题拆成**有序**子问题列表 sub_questions, 用于**依次向量检索**。要求：
    1. 链式推理、多层关系、因果先后的问题，必须拆成多条；单跳即可答的也可只输出1条。
    2. 每条子问题必须是**可独立检索**的完整中文问句，**禁止**使用「他/她/此人/上文」等指代；要写全人物名与事件名。
    3. 顺序必须符合推理链：先搞清前置实体/事实，再查后续结论。
    4. 【结论层必拆】「为什么/评价/差距/对比」类问题，不能只拆背景层（如早期经历、某个时期的细节），必须至少拆出一条**结果层**子问题，覆盖最终成就、后期评价或原著明说的对比依据（例如「洪最终修炼到什么境界、在原著中是什么定位」），避免所有子问题都停留在问题字面提到的时间段。
    5. **不要**把整句原题原样复制成唯一一条（除非确实无法拆分）；不要拆成过碎的关键词列表。
    6. 输出 1～8 条即可。

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
  return {
    documents: merged,
    retrievalCount: round,
    nextSubIdx: idx + 1,
    currentQuery: q,
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
子问题序列：
${subList || '无'}

已检索轮次: ${state.retrievalCount}; 剩余未检索子问题条数: ${remaining}
最大检索轮数上限: ${state.maxRetrievalCount}

已召回文档摘要:
${docStr}

请判断下一步:
1) 已有足够信息回答用户原始问题 -> nextAction = generate
2) 仍缺关键事实、且仍存在未检索的子问题、且未超过轮数上限 -> nextAction = retrieve
硬性规则：
- 若剩余未检索子问题条数为 0，必须 nextAction = generate
- 若已检索轮数已经到达或超过最大检索轮数，必须 nextAction = generate`

  const planner = planModel.withStructuredOutput(NextStepSchema)
  const { nextAction, reason } = await planner.invoke(prompt)

  // 兜底硬规则（不信任 LLM 一定遵守）
  let finalNext = nextAction
  if (state.retrievalCount >= state.maxRetrievalCount) finalNext = 'generate'
  if (remaining <= 0) finalNext = 'generate'
  console.log(`[决策] nextAction=${finalNext}（LLM建议: ${nextAction}）原因: ${reason}`)
  // 思考过程推流：规划决策
  config?.configurable?.sink?.onThink?.(
    finalNext === 'retrieve'
      ? '评估：关键事实仍缺失，继续检索下一子问题'
      : `评估：已累计${(state.documents ?? []).length}条片段，信息足够，开始组织答案`
  )
  return { planedNext: finalNext }
}

// 条件边：规划器决策写回 state 后由这里读取（不能读 strategy，那是路由的字段）
const afterPlan = (state) => (state.planedNext === 'retrieve' ? 'retrieve' : 'generate')

// 条件边：检索后若已无未检索子问题、或已达轮数上限 → 直接生成
// 此时规划结果必然是 generate（硬规则），跳过规划器省一次 LLM 调用（3~6s）
const afterRetrieve = (state) => {
  const remaining = (state.subQuestions ?? []).length - (state.nextSubIdx ?? 0)
  const budgetHit = (state.retrievalCount ?? 0) >= (state.maxRetrievalCount ?? 3)
  return (remaining <= 0 || budgetHit) ? 'generate' : 'plan'
}

// ===== 节点 6：RAG 生成（流式输出到 sink） =====
const generateNode = async (state, config) => {
  console.log('----RAG_GENERATE----')
  const sink = config?.configurable?.sink
  const docs = state.documents ?? []

  // 多跳全部检索完仍无文档 → 与原 /api/chat 一致的兜底文案
  if (docs.length === 0) {
    const fallback = '抱歉，没有在《吞噬星空》中找到相关内容。'
    sink?.onThink?.('知识库中未检索到相关片段，将如实告知用户')
    sink?.onToken?.(fallback)
    return { generation: fallback }
  }

  const context = docs
    .map((item, i) => `[片段${i + 1}] 章节号:${item.chapter_num}, 内容:${item.content}`)
    .join('\n\n----\n\n')
  const prompt = `你是一个专业的《吞噬星空》小说助手。
基于小说回答问题，用准确、详细的语言。请根据以下小说片段内容回答问题：
${context}

用户问题：${state.question}

回答要求：
1. 优先综合多个片段回答问题；只有片段与问题**完全无关**时才告知无法回答。
2. 部分回答策略：如果片段只能覆盖问题的**一部分**，先基于片段把能答的部分答好（说明依据的章节），再明确指出哪些部分片段未覆盖，**不要**因为个别部分缺失就整体拒答。
3. 「为什么/评价/对比」类问题，允许基于片段中的事实（机缘、传承、境界、战绩）做合理分析推断，但需注明这是基于检索片段的推断。
4. 回答要准确，符合小说情节和人物设定。
5. 可以引用原文内容来支持你的回答。

ai助手的回答：`

  // sources 事件领先于正文发送——前端先渲染来源区，再流式填正文
  sink?.onSources?.(formatSources(docs))
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

// 路由条件边：simple → 直接回答；complex → 拆解
const afterRoute = (state) => (state.strategy === 'simple' ? 'direct_answer' : 'decompose_question')

// ===== 建图 =====
// route → (simple) direct_answer → END
//       → (complex) decompose → retrieve →（还有子问题且未到上限）plan ⇄ retrieve（多跳循环）
//                                        └→（无剩余子问题或达上限，跳过规划） generate → END
const graph = new StateGraph(GraphState)
  .addNode('route_question', routeQuestionNode)
  .addNode('direct_answer', directAnswerNode)
  .addNode('decompose_question', decomposeQuestionNode)
  .addNode('retrieve', retrieveNode)
  .addNode('plan_next_step', planNextStepNode)
  .addNode('rag_generate', generateNode)
  .addEdge(START, 'route_question')
  .addConditionalEdges('route_question', afterRoute, {
    direct_answer: 'direct_answer',
    decompose_question: 'decompose_question',
  })
  .addEdge('decompose_question', 'retrieve')
  .addConditionalEdges('retrieve', afterRetrieve, {
    plan: 'plan_next_step',
    generate: 'rag_generate',
  })
  .addConditionalEdges('plan_next_step', afterPlan, {
    retrieve: 'retrieve',
    generate: 'rag_generate',
  })
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
export async function runAgenticRAG({ question, k = TOP_K, maxRetrievalCount = 3, sink }) {
  return graph.invoke(
    {
      question,
      k,
      maxRetrievalCount,
      strategy: '',
      routeReason: '',
      subQuestions: [],
      nextSubIdx: 0,
      currentQuery: '',
      retrievalCount: 0,
      planedNext: '',
      documents: [],
      generation: '',
    },
    { configurable: { sink } } // sink 走 LangGraph configurable 通道注入节点（并发安全，不用全局变量）
  )
}
