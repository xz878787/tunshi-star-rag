// ragGraph.mjs 必须第一个导入：它内部按模块位置加载项目根的 .env，
// 保证后续 db.js / jwt 等模块求值时环境变量已就绪（从任意目录启动均可）
import { runAgenticRAG, initRagGraph } from './ragGraph.mjs'
import express from 'express'
import authRoutes from './routes/auth.js'
import chatRoutes from './routes/chat.js'
import { authMiddleware } from './middleware/auth.js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import { createConversation, appendMessage, getConversation } from './models/chatModel.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.static(join(__dirname, '..', 'public')))
app.use('/api/auth', authRoutes)
app.use('/api/conversations', chatRoutes)

// ===== API 路由 =====
// /api/chat = 胶水层：只负责 HTTP 编排（鉴权 → 会话 → 调图 → 流式转发 → 落库）
app.post('/api/chat', authMiddleware, async (req, res) => {
  let conversationId = null
  let sourcesSent = false    // sources 事件是否已发送
  let accumulatedText = ''   // 流式累积的完整回答
  // 思考过程累积：随 think 事件同步收集，最后随 assistant 消息一起落库（历史回放可复现）
  const thinkLines = []
  let thinkFirstAt = 0       // 第一条思考的时间戳
  let thinkLastAt = 0        // 最后一条思考的时间戳
  let thinkSeconds = null    // 思考用时（秒）：首个正文 token 到达时定格
  try {
    const { question, conversationId: clientConvId } = req.body
    if (!question) {
      return res.status(400).json({ error: '请输入问题' })
    }

    const userId = req.user.userId

    // ===== 落库准备：确认本次问答挂在哪个会话上 =====
    if (clientConvId) {
      // 前端带了会话 id → 校验归属（越权防护：不属于当前用户则拒绝）
      const conv = await getConversation(Number(clientConvId), userId)
      if (!conv) {
        return res.status(403).json({ error: '会话不存在或无权访问' })
      }
      conversationId = conv.id
    } else {
      // 前端没带 → 自动新建会话，标题取问题前 20 字
      const title = question.trim().slice(0, 20) || '新对话'
      const created = await createConversation(userId, title)
      conversationId = created.id
    }

    // 先落库用户问题
    await appendMessage(conversationId, 'user', question, null)

    // 开启流式响应：NDJSON 事件流协议——每行一个 JSON 事件（JSON.stringify 保证内部换行被转义，物理单行）
    // 事件顺序：meta（会话）→ think…（思考步骤）→ sources（检索来源）→ token…（正文）→ done（总用时）
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no') // 防止 Nginx 等网关缓存整段再给前端
    res.flushHeaders()

    const t0 = Date.now()
    const send = (obj) => res.write(JSON.stringify(obj) + '\n')

    // 先发 meta：前端立刻拿到会话 id 并创建消息容器（思考步骤随后源源不断推过来）
    send({ type: 'meta', conversationId })

    // ===== 胶水核心：把 HTTP 流式包装成事件 sink，注入 LangGraph 图执行 =====
    // 图内节点通过 config.configurable.sink 回调推送思考步骤 / token / 来源（并发安全，不用全局变量）
    const sink = {
      onThink: (text) => {
        const now = Date.now()
        if (!thinkFirstAt) thinkFirstAt = now
        thinkLastAt = now
        thinkLines.push(text)
        send({ type: 'think', text })
      },
      onToken: (text) => {
        // 首个正文 token 到达 → 思考阶段结束，定格思考用时
        if (thinkSeconds === null && thinkFirstAt) {
          thinkSeconds = Number(((Date.now() - thinkFirstAt) / 1000).toFixed(1))
        }
        accumulatedText += text
        send({ type: 'token', text })
      },
      onSources: (sources) => {
        sourcesSent = true
        send({ type: 'sources', sources })
      },
    }

    // 跑完整 agentic RAG 图：路由 → 拆解 → 多跳检索 → 规划 → 生成
    const result = await runAgenticRAG({
      question,
      k: 5,               // 每轮检索条数（与原 /api/chat 一致）
      maxRetrievalCount: 3, // 多跳检索轮数上限
      sink,
    })

    // 兜底：图执行完却没触发过 sources（极端情况）→ 用最终 state 补发，保证前端协议完整
    if (!sourcesSent) {
      send({
        type: 'sources',
        sources: (result.documents ?? []).map((d) => ({
          chapter: d.chapter_num,
          score: Number(d.score).toFixed(4),
          content: d.content,
        })),
      })
    }
    // done 事件：总耗时（秒），前端用它收尾思考区
    send({ type: 'done', elapsed: Number(((Date.now() - t0) / 1000).toFixed(1)) })
    res.end()

    // 流结束后才落库 AI 完整回答 + 来源（assistant 消息）
    const sources = (result.documents ?? []).map((d) => ({
      chapter: d.chapter_num,
      score: Number(d.score).toFixed(4),
      content: d.content,
    }))
    const answer = result.generation || accumulatedText
    // 思考过程随消息落库：{ lines: [...], seconds } 结构（JSON 列）；兜底用首尾 think 时间差
    const thinking = thinkLines.length
      ? {
          lines: thinkLines,
          seconds: thinkSeconds ?? Number(((thinkLastAt - thinkFirstAt) / 1000).toFixed(1)),
        }
      : null
    if (answer) {
      await appendMessage(conversationId, 'assistant', answer, sources, thinking)
    }
  } catch (error) {
    console.error('API Error:', error)
    if (!res.headersSent) {
      // 还没开始推送就报错 → 返回 JSON 错误
      return res.status(500).json({ error: '服务器内部错误，请稍后再试' })
    }
    // 已经开始流式推送 → 直接结束流（前端靠已收到的半截内容兜底）
    res.end()
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
    await initRagGraph() // Milvus 连接 + 集合加载（已抽到 ragGraph.mjs）

    app.listen(PORT, () => {
      console.log(`\n吞噬星空 RAG 助手已启动（Agentic RAG 图引擎）！`)
      console.log(`打开浏览器访问: http://localhost:${PORT}\n`)
    })
  } catch (error) {
    console.error('启动失败:', error)
    process.exit(1)
  }
}

start()
