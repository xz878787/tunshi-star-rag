// ==================== 会话相关路由 ====================
// 只负责 URL → 处理函数的映射，全部接口都需要登录（authMiddleware）
import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import {
  createConversation,
  appendMessage,
  listConversations,
  getConversation,
  getMessages,
  deleteConversation,
} from '../models/chatModel.js'

const router = Router()

// 以下所有接口都必须携带有效 token
router.use(authMiddleware)

/**
 * 创建新会话
 * POST /api/conversations
 * body: { title? }
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.user.userId
    const title = (req.body.title || '新对话').trim().slice(0, 100)
    const { id } = await createConversation(userId, title)
    res.json({ code: 200, msg: '创建成功', data: { id, title } })
  } catch (err) {
    console.error('创建会话失败:', err)
    res.status(500).json({ code: 500, msg: '服务器内部错误' })
  }
})

/**
 * 当前用户的会话列表（倒序）
 * GET /api/conversations
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user.userId
    const list = await listConversations(userId)
    res.json({ code: 200, msg: '获取成功', data: list })
  } catch (err) {
    console.error('获取会话列表失败:', err)
    res.status(500).json({ code: 500, msg: '服务器内部错误' })
  }
})

/**
 * 会话详情（含全部消息）
 * GET /api/conversations/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const userId = req.user.userId
    const conversationId = Number(req.params.id)
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ code: 400, msg: '无效的会话 id' })
    }

    // 归属校验：id + user_id 同时匹配，否则查不到（越权防护）
    const conv = await getConversation(conversationId, userId)
    if (!conv) {
      return res.status(404).json({ code: 404, msg: '会话不存在' })
    }

    const messages = await getMessages(conversationId)
    res.json({ code: 200, msg: '获取成功', data: { ...conv, messages } })
  } catch (err) {
    console.error('获取会话详情失败:', err)
    res.status(500).json({ code: 500, msg: '服务器内部错误' })
  }
})

/**
 * 删除会话及其消息
 * DELETE /api/conversations/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.user.userId
    const conversationId = Number(req.params.id)
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ code: 400, msg: '无效的会话 id' })
    }

    const ok = await deleteConversation(conversationId, userId)
    if (!ok) {
      return res.status(404).json({ code: 404, msg: '会话不存在' })
    }
    res.json({ code: 200, msg: '删除成功' })
  } catch (err) {
    console.error('删除会话失败:', err)
    res.status(500).json({ code: 500, msg: '服务器内部错误' })
  }
})

export default router
