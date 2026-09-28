// ==================== 混合检索：进程内 BM25 稀疏路 + RRF 融合（单文件最小实现） ====================
// 本文件一个文件包含稀疏路的全部环节：
//   EPUB 重算语料 → bigram 中文分词 → BM25 倒排索引 → 稀疏召回 → RRF 双通道融合
// 设计约束：
//   - 零新依赖：分词用滑动二元组（不用 jieba 原生模块），索引用纯 JS Map，无需 ES；
//   - 不在模块顶层读 env（import 提升会早于 ragGraph.mjs 的 dotenv.config()），env 一律调用时读；
//   - 任何异常都降级返回 []，稀疏路是增强不是必需，绝不能阻断问答。
import { EPubLoader } from '@langchain/community/document_loaders/fs/epub'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'

// ===== 常量（切分参数必须与 src/main.mjs 灌 Milvus 时逐字一致，id 才能对齐做 RRF 去重） =====
const BOOK_ID = 1
const CHUNK_SIZE = 500
const CHUNK_OVERLAP = 50
const MIN_CHAPTER_CHARS = 100 // 内容过短的章节视为 EPUB 插图页，跳过
const BM25_K1 = 1.2 // 词频饱和系数
const BM25_B = 0.75 // 文档长度归一化系数
const RRF_K = 60 // RRF 融合常数，越大则名次差异越平滑

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_EPUB = join(PROJECT_ROOT, '吞噬星空 (我吃西红柿) .epub')

// ==================== ① 稀疏语料：从 EPUB 重算切片（零 embedding 调用） ====================
// 为什么不从 Milvus 全量拉：分页受 gRPC 4MB 限制只能捞回 10970 个唯一 id（实际 11977），
// 少的 1007 条将永远无法被关键词召回——而字面命中正是稀疏路存在的意义。
let corpusPromise = null // 模块级 memo：EPUB 解析 + 切片只做一次

export function loadSparseCorpus() {
  if (!corpusPromise) {
    corpusPromise = buildSparseCorpus().catch((error) => {
      corpusPromise = null // 失败不缓存，允许下次重试
      throw error
    })
  }
  return corpusPromise
}

async function buildSparseCorpus() {
  const epubFile = process.env.EPUB_FILE ? resolve(process.env.EPUB_FILE) : DEFAULT_EPUB
  const startedAt = Date.now()

  const loader = new EPubLoader(epubFile, { splitChapters: true }) // 按章节切分成多个 Document
  const documents = await loader.load()
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP, // 重叠 50 字符，保持上下文连贯
  })

  const corpus = []
  let skippedChapters = 0
  for (let chapterIndex = 0; chapterIndex < documents.length; chapterIndex++) {
    const chapterContent = documents[chapterIndex]?.pageContent ?? ''
    // 跳过插图短章节，但章号仍按原始下标计数（与 main.mjs 一致）
    if (chapterContent.length < MIN_CHAPTER_CHARS) {
      skippedChapters++
      continue
    }
    const chunks = await splitter.splitText(chapterContent)
    const chapterNum = chapterIndex + 1
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      corpus.push({
        id: `${BOOK_ID}_${chapterNum}_${chunkIndex}`, // ★ 必须与 Milvus 的 id 规则逐字一致
        content: chunks[chunkIndex],
        chapter_num: chapterNum,
        book_id: BOOK_ID,
      })
    }
  }

  console.log(
    `稀疏语料重算完成：${corpus.length} 条切片 / ${documents.length} 章（跳过 ${skippedChapters} 个插图页），` +
      `耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  )
  return corpus
}

// ==================== ② 分词：中文 bigram（滑动二元组），英文整词小写 ====================
// 实测 IK 会把「罗峰」切成 罗|峰（人名拆单字），bigram 保留「罗峰」整体，人名命中率反而更高。
const isCjk = (ch) => {
  const code = ch.codePointAt(0)
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xf900 && code <= 0xfaff) // CJK 兼容表意
  )
}

const isAsciiWord = (ch) => {
  const code = ch.codePointAt(0)
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f // 下划线
  )
}

export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = []
  let cjkRun = []
  let asciiRun = []

  const flushCjk = () => {
    if (!cjkRun.length) return
    if (cjkRun.length === 1) {
      tokens.push(cjkRun[0]) // 长度 1 的串保留单字
    } else {
      for (let i = 0; i + 1 < cjkRun.length; i++) tokens.push(cjkRun[i] + cjkRun[i + 1])
    }
    cjkRun = []
  }
  const flushAscii = () => {
    if (!asciiRun.length) return
    tokens.push(asciiRun.join(''))
    asciiRun = []
  }

  for (const ch of s) {
    if (isCjk(ch)) {
      flushAscii()
      cjkRun.push(ch)
    } else if (isAsciiWord(ch)) {
      flushCjk()
      asciiRun.push(ch)
    } else {
      flushCjk() // 标点/空白作分隔符
      flushAscii()
    }
  }
  flushCjk()
  flushAscii()
  return tokens
}

// ==================== ③ BM25 倒排索引（构建一次，常驻内存） ====================
export function buildBm25Index(docs, { k1 = BM25_K1, b = BM25_B } = {}) {
  const items = (docs ?? []).filter((d) => d && d.id != null)
  const N = items.length
  const lengths = new Int32Array(N) // 每篇切片的词数
  const postings = new Map() // term → { df, docIdxs, tfs }
  let totalLen = 0

  for (let i = 0; i < N; i++) {
    const tokens = tokenize(items[i].content)
    lengths[i] = tokens.length
    totalLen += tokens.length

    // 先在本篇内统计词频再一次性写倒排（避免同一 term 在同一篇被重复 push）
    const tf = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const [term, freq] of tf) {
      let p = postings.get(term)
      if (!p) {
        p = { df: 0, docIdxs: [], tfs: [] }
        postings.set(term, p)
      }
      p.df++
      p.docIdxs.push(i)
      p.tfs.push(freq)
    }
  }

  return { items, N, k1, b, avgdl: N ? totalLen / N : 0, lengths, postings }
}

// IDF：加 1 保证非负；词越稀有（df 越小）权重越高
const idf = (df, N) => Math.log(1 + (N - df + 0.5) / (df + 0.5))

// BM25 检索：返回分【无上界】（实测最高 33.24），只能用于通道内排名，绝不进 topScore / 前端相似度
function searchBm25(index, query, topK) {
  if (!index || !index.N) return []
  const terms = [...new Set(tokenize(query))]
  if (!terms.length) return []

  const scores = new Map() // docIdx → 累计 BM25 分
  for (const term of terms) {
    const p = index.postings.get(term)
    if (!p) continue // 倒排表没有这个词（如小说库查「高血糖」）→ 跳过不加分
    const w = idf(p.df, index.N)
    for (let j = 0; j < p.docIdxs.length; j++) {
      const docIdx = p.docIdxs[j]
      const tf = p.tfs[j]
      const len = index.lengths[docIdx]
      const norm =
        (tf * (index.k1 + 1)) / (tf + index.k1 * (1 - index.b + (index.b * len) / index.avgdl))
      scores.set(docIdx, (scores.get(docIdx) ?? 0) + w * norm)
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, topK))
    .map(([docIdx, score]) => ({ ...index.items[docIdx], score }))
}

// ==================== ④ 索引单例 + 预热 + 稀疏召回 ====================
let indexPromise = null

function getIndex() {
  if (!indexPromise) {
    indexPromise = loadSparseCorpus()
      .then((docs) => {
        const startedAt = Date.now()
        const index = buildBm25Index(docs)
        console.log(`进程内 BM25 索引构建完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
        return index
      })
      .catch((error) => {
        indexPromise = null // 失败不缓存
        throw error
      })
  }
  return indexPromise
}

// 启动时预热（约 2.4s），避免首次问答白等
export async function warmupSparse() {
  if ((process.env.SPARSE_BACKEND ?? 'memory') === 'none') {
    console.log('稀疏路已关闭（SPARSE_BACKEND=none），跳过 BM25 索引构建')
    return
  }
  await getIndex()
}

/**
 * 稀疏路召回：纯本地倒排查表，零 API 调用
 * @param {string} query 查询问句
 * @param {number} topK 返回条数
 * @returns {Promise<Array>} 带 channel='sparse' 标记的片段；关闭或异常时返回 []
 */
export async function sparseRecall(query, topK = 15) {
  if ((process.env.SPARSE_BACKEND ?? 'memory') === 'none') return []
  try {
    const index = await getIndex()
    return searchBm25(index, query, topK).map((d) => ({ ...d, channel: 'sparse' }))
  } catch (error) {
    console.warn('稀疏路检索失败，本轮降级为纯向量：', String(error.message).split('\n')[0])
    return []
  }
}

// ==================== ⑤ 编号/型号/规范代号硬过滤（融合后剔除不含编号字面的候选） ====================
// 场景：查「GB/T 19001」「iPhone15」这类编号时，稠密路会召回语义相近但不含编号的泛论片段。
// 规则：从查询提取【含数字的 ASCII 词】（长度≥3，天然避开「第3章」这类短数字），
//       候选必须命中至少一个编号 token，否则剔除；一个都不剩时回退原候选（防编号写错全军覆没）。
// 中文专名（如「二甲双胍」）不纳入：bigram 组合太宽，硬过滤会误杀，交给 IDF 与重排自然裁决。
const IDENTIFIER_MIN_LEN = 3

export function extractIdentifiers(query) {
  return [...new Set(tokenize(query))].filter(
    (t) => /^[a-z0-9_]+$/.test(t) && /\d/.test(t) && t.length >= IDENTIFIER_MIN_LEN
  )
}

/**
 * 按编号字面过滤融合候选
 * @param {Array} candidates RRF 融合后的候选
 * @param {string} query 原始查询问句
 * @returns {Array} 含编号 token 的候选；查询无编号或过滤后为空时原样返回
 */
export function filterByIdentifier(candidates, query) {
  const ids = extractIdentifiers(query)
  if (!ids.length || !candidates?.length) return candidates
  const kept = candidates.filter((d) => {
    const terms = new Set(tokenize(d.content))
    return ids.some((id) => terms.has(id))
  })
  return kept.length ? kept : candidates // 全被滤光说明编号可能写错 → 回退，不制造空结果
}

// ==================== ⑥ RRF 融合：只按名次合路，跨通道免分数归一化 ====================
/**
 * @param {Array<Array>} rankedLists 每路按相关性降序的结果列表（调用方须把稠密路排在稀疏路之前）
 * @param {{k?: number, topK?: number}} [opts] k=RRF 常数；topK=融合后截断条数
 * @returns {Array} 融合去重后的文档；同 id 保留首个列表里的对象
 */
export function rrfFuse(rankedLists, { k = RRF_K, topK } = {}) {
  const lists = (rankedLists ?? []).filter((l) => Array.isArray(l) && l.length > 0)
  const scores = new Map() // id → 累计 RRF 分
  const firstSeen = new Map() // id → 首次出现的文档对象

  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const doc = list[i]
      if (doc == null) continue
      const id = doc.id == null ? '' : String(doc.id).trim()
      if (!id) continue
      if (!firstSeen.has(id)) firstSeen.set(id, doc) // 稠密路排前面 → 同 id 保住 COSINE 分
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1))
    }
  }

  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1])
  const limit = Number.isFinite(topK) && topK > 0 ? topK : ordered.length
  return ordered.slice(0, limit).map(([id]) => firstSeen.get(id))
}
