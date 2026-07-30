import 'dotenv/config'
import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import {
  MilvusClient,
  MetricType,
} from '@zilliz/milvus2-sdk-node'
import {
  OpenAIEmbeddings,
  ChatOpenAI,
} from '@langchain/openai'
import { SystemMessage } from '@langchain/core/messages'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.static(join(__dirname, '..', 'public')))

// ===== RAG 组件初始化 =====
const COLLECTION_NAME = 'ebook8'
const VECTOR_DIM = 1024

const embedding = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.EMBEDDINGS_MODEL_NAME,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL,
  },
  dimensions: VECTOR_DIM,
})

const model = new ChatOpenAI({
  temperature: 0.7,
  model: process.env.MODEL_NAME,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL,
  },
})

const client = new MilvusClient({
  address: process.env.MILVUS_ADDRESS,
  token: process.env.MILVUS_TOKEN,
})

// ===== RAG 核心函数 =====
const getEmbedding = async (text) => {
  const result = await embedding.embedQuery(text)
  return result
}

const retrieveRelevantContent = async (question, k = 5) => {
  const queryVector = await getEmbedding(question)
  const searchResult = await client.search({
    collection_name: COLLECTION_NAME,
    vectors: [queryVector],
    limit: k,
    metric_type: MetricType.COSINE,
    output_fields: ['id', 'content', 'book_id', 'chapter_num'],
  })
  return searchResult.results
}

const buildPrompt = (question, retrievedChunks) => {
  const context = retrievedChunks
    .map((item, i) =>
      `[片段${i + 1}] 章节号:${item.chapter_num}, 内容:${item.content}`
    )
    .join('\n\n----\n\n')

  return `你是一个专业的《吞噬星空》小说助手。
基于小说回答问题，用准确、详细的语言。请根据以下小说片段内容回答问题：
${context}

用户问题：${question}

回答要求：
1. 如果片段中有相关信息，请结合小说内容给出详细准确的回答，如果没有请说不知道。
2. 可以综合多个片段的内容，提供完整的答案。
3. 如果片段中没有相关信息，请如实告知用户。
4. 回答要准确，符合小说情节和人物设定。
5. 可以引用原文内容来支持你的回答。

ai助手的回答：`
}

// ===== API 路由 =====
app.post('/api/chat', async (req, res) => {
  try {
    const { question } = req.body
    if (!question) {
      return res.status(400).json({ error: '请输入问题' })
    }

    const results = await retrieveRelevantContent(question, 5)
    console.log('Search results count:', results?.length)
    if (results && results.length > 0) {
      console.log('First result content_len:', results[0].content.length)
      console.log('First result preview:', results[0].content?.substring(0, 100))
    }
    if (!results || results.length === 0) {
      return res.json({
        answer: '抱歉，没有在《吞噬星空》中找到相关内容。',
        sources: [],
      })
    }

    const prompt = buildPrompt(question, results)
    const response = await model.invoke([new SystemMessage(prompt)])

    const sources = results.map((item) => ({
      chapter: item.chapter_num,
      score: item.score.toFixed(4),
      content: item.content,
    }))

    res.json({
      answer: response.content,
      sources,
    })
  } catch (error) {
    console.error('API Error:', error)
    res.status(500).json({ error: '服务器内部错误，请稍后再试' })
  }
})

// 获取音乐文件列表
app.get('/api/audio', (req, res) => {
  try {
    const audioDir = join(__dirname, '..', 'public', 'assets', 'audio')
    const files = fs.readdirSync(audioDir)
    const audio = files
      .filter(f => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f))
      .map(f => `/assets/audio/${encodeURIComponent(f)}`)
    res.json({ success: true, audio })
  } catch (error) {
    res.json({ success: true, audio: [] })
  }
})

// 获取图片列表
app.get('/api/images', (req, res) => {
  try {
    const imagesDir = join(__dirname, '..', 'public', 'assets', 'images')
    const files = fs.readdirSync(imagesDir)
    const images = files
      .filter(f => /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f))
      .map(f => `/assets/images/${encodeURIComponent(f)}`)
    res.json({ success: true, images })
  } catch (error) {
    res.json({ success: true, images: [] })
  }
})

// ===== 启动 =====
async function start() {
  try {
    await client.connect()
    console.log('Milvus 连接成功')

    try {
      await client.loadCollection({ collection_name: COLLECTION_NAME })
      console.log('集合加载完成')
    } catch (e) {
      console.log('集合已在加载状态')
    }

    app.listen(PORT, () => {
      console.log(`\n吞噬星空 RAG 助手已启动！`)
      console.log(`打开浏览器访问: http://localhost:${PORT}\n`)
    })
  } catch (error) {
    console.error('启动失败:', error)
    process.exit(1)
  }
}

start()
