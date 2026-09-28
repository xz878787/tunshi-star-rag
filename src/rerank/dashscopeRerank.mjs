// ==================== DashScope 文本重排器（cross-encoder 精排） ====================
// 改造自 advanced-rag/src/rerank/dashscope-rerank.mjs，三处刻意分歧：
//   ① 取正文兼容 .content 与 .pageContent —— 本项目的检索结果是普通对象 { id, content, score, chapter_num }，
//      不是 LangChain Document；参考实现写死 d.pageContent 会拿到 undefined，重排直接返回一堆 undefined
//   ② 保留 relevance_score 为 rerankScore，且【不覆盖原 score】—— score 是 COSINE，
//      被 0~1 的重排分覆盖会毁掉 afterRetrieve 的 0.55 低分联网兜底阈值
//   ③ 类内【不读 env】：apiKey / model / baseUrl 全部由构造参数显式传入，
//      避免「哪个模块先加载 .env」这种隐式依赖（本项目按模块位置解析 .env，两套混用会踩坑）
//   ④ 顺手删掉参考实现里的 console.log(results) 调试残留（线上每轮检索都会刷一坨 JSON）
import { BaseDocumentCompressor } from '@langchain/core/retrievers/document_compressors'

export class DashscopeRerank extends BaseDocumentCompressor {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey DashScope API Key
   * @param {string} opts.model 重排模型名（如 qwen3-rerank）
   * @param {number} [opts.topN] 重排后保留条数
   * @param {string} opts.baseUrl DashScope 原生 text-rerank 地址（不是 compatible-mode，那边 404）
   */
  constructor({ apiKey, model, topN = 3, baseUrl }) {
    super()
    this.apiKey = apiKey
    this.model = model
    this.topN = topN
    this.baseUrl = baseUrl
  }

  /**
   * 对候选文档按与 query 的相关性重排
   * @param {Array} documents 候选文档（普通对象数组，含 content / id / score / chapter_num）
   * @param {string} query 重排依据的查询句
   * @returns {Promise<Array>} 重排后保留 topN 条；每条附带 rerankScore，原 score 原样保留
   */
  async compressDocuments(documents, query, _callbacks) {
    const list = documents ?? []
    if (!list.length) return []

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      // DashScope 原生协议：input/parameters 包壳（参考实现用的就是这套形状）
      body: JSON.stringify({
        model: this.model,
        input: {
          query,
          // 兼容两种正文取法：本项目是 .content，LangChain Document 是 .pageContent
          documents: list.map((d) => String(d.content ?? d.pageContent ?? '')),
        },
        parameters: {
          return_documents: false, // 只要下标与分数，正文我们本地已有
          top_n: this.topN,
        },
      }),
    })

    // 非 2xx：先用 text() 拿原始错误体再抛（此时对错误响应调 json() 会解析失败，掩盖真实错误）
    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      throw new Error(`DashScope rerank ${res.status}: ${errorText.slice(0, 200)}`)
    }

    const json = await res.json()
    const results = json?.output?.results
    // 返回结构异常直接抛，交给调用方（retrieveWithRerank）统一降级处理
    if (!Array.isArray(results)) {
      throw new Error(`unexpected rerank response: ${JSON.stringify(json).slice(0, 200)}`)
    }

    return results
      .filter((item) => list[item.index] != null) // 防脏下标越界
      .map((item) => ({
        ...list[item.index], // 原对象原样透传（score 仍是 COSINE，量纲不被污染）
        rerankScore: item.relevance_score, // 重排分单独挂一个字段，只用于观测与排序
      }))
  }
}