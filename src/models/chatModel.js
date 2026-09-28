// ==================== 会话/消息数据访问层 (Model) ====================
// 只负责 conversations / messages 两张表的增删查，不写业务逻辑
import { query } from './db.js'
import pool from './db.js'

/**
 * 新建会话
 * @param {number} userId 所属用户
 * @param {string} title 会话标题（通常取第一条用户消息前 N 字）
 * @returns {Promise<Object>} 插入后的 { id }
 */
export async function createConversation(userId, title) {
  const result = await query(
    'INSERT INTO conversations (user_id, title) VALUES (?, ?)',
    [userId, title]
  )
  return { id: result.insertId }
}

/**
 * 向会话追加一条消息
 * @param {number} conversationId 会话 id
 * @param {string} role user / assistant
 * @param {string} content 消息内容
 * @param {Array|null} sources RAG 来源（assistant 消息才有）
 * @param {Object|null} thinking 思考过程 { lines: [...], seconds }（assistant 消息才有）
 * @returns {Promise<Object>} 插入后的 { id }
 */
export async function appendMessage(conversationId, role, content, sources = null, thinking = null) {
  const result = await query(
    'INSERT INTO messages (conversation_id, role, content, sources, thinking) VALUES (?, ?, ?, ?, ?)',
    [
      conversationId,
      role,
      content,
      sources ? JSON.stringify(sources) : null,
      thinking ? JSON.stringify(thinking) : null,
    ]
  )
  return { id: result.insertId }
}

/**
 * 查询某用户的会话列表（按更新时间倒序）
 * @param {number} userId
 * @returns {Promise<Array>} 会话列表
 */
export async function listConversations(userId) {
  const rows = await query(
    'SELECT id, title, create_time, update_time FROM conversations WHERE user_id = ? ORDER BY update_time DESC',
    [userId]
  )
  return rows
}

/**
 * 按 id + 归属用户查询单个会话（用于越权校验）
 * 必须同时满足 id 和 user_id，否则返回 null
 * @param {number} conversationId
 * @param {number} userId
 * @returns {Promise<Object|null>}
 */
export async function getConversation(conversationId, userId) {
  const rows = await query(
    'SELECT id, title, create_time, update_time FROM conversations WHERE id = ? AND user_id = ?',
    [conversationId, userId]
  )
  return rows[0] || null
}

/**
 * 查询某会话的全部消息（按时间正序）
 * @param {number} conversationId
 * @returns {Promise<Array>} 消息列表（sources / thinking 已解析为对象）
 */
export async function getMessages(conversationId) {
  const rows = await query(
    'SELECT id, role, content, sources, thinking, create_time FROM messages WHERE conversation_id = ? ORDER BY create_time ASC, id ASC',
    [conversationId]
  )
  // JSON 列可能返回字符串（旧驱动行为）或对象，统一解析成对象
  const parseJson = (v) =>
    v ? (typeof v === 'string' ? JSON.parse(v) : v) : null
  return rows.map((m) => ({
    ...m,
    sources: parseJson(m.sources),
    thinking: parseJson(m.thinking),
  }))
}

// ===== 记忆配置（滑动摘要 + 滑窗 混合策略）=====
// 滑窗保证「最近细节」精确，摘要保证「远期脉络」不丢——两者互补，缺一不可
export const MEMORY_RECENT_LIMIT = 8      // 滑窗保留的最近消息条数
export const MEMORY_SUMMARY_TRIGGER = 12  // 窗口外「未摘要」消息达到该条数时触发一次摘要

/**
 * 读取会话的记忆状态：摘要 + 滑窗消息 + 待摘要条数。
 *
 * 摘要与滑窗靠 summary_upto_id 无缝衔接：
 *   摘要覆盖区间  (0, uptoId]
 *   待摘要区间    (uptoId, windowStartId)  ← 已滑出窗口、但还没被压缩进摘要的部分
 *   滑窗区间      [windowStartId, 最新]
 * 三者不重叠，因此不会重复摘要同一批消息。
 *
 * @param {number} conversationId
 * @param {number} recentLimit 滑窗条数
 * @returns {Promise<{summary:string, uptoId:number, recentMessages:Array, windowStartId:number, pendingCount:number}>}
 */
export async function getMemoryState(conversationId, recentLimit = MEMORY_RECENT_LIMIT) {
  const safeLimit = Math.min(Math.max(Number(recentLimit) || 8, 1), 20)

  // 1. 会话上挂着的摘要与覆盖点
  const convRows = await query(
    'SELECT summary, summary_upto_id FROM conversations WHERE id = ?',
    [conversationId]
  )
  const summary = convRows[0]?.summary || ''
  const uptoId = Number(convRows[0]?.summary_upto_id || 0)

  // 2. 滑窗：最近 N 条（倒序取再反转，保证拿到的是「最近」而非「最早」）
  const recentRows = await query(
    `SELECT id, role, content FROM messages
     WHERE conversation_id = ?
     ORDER BY id DESC
     LIMIT ${safeLimit}`,
    [conversationId]
  )
  const recentMessages = recentRows.reverse()
  const windowStartId = recentMessages.length ? Number(recentMessages[0].id) : 0

  // 3. 待摘要条数：id 落在 (uptoId, windowStartId) 的消息数
  let pendingCount = 0
  if (windowStartId > uptoId) {
    const cntRows = await query(
      'SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND id > ? AND id < ?',
      [conversationId, uptoId, windowStartId]
    )
    pendingCount = Number(cntRows[0]?.c || 0)
  }

  return { summary, uptoId, recentMessages, windowStartId, pendingCount }
}

/**
 * 取待摘要区间的旧消息（时间正序），供摘要器压缩
 * @param {number} conversationId
 * @param {number} uptoId 摘要已覆盖到的消息 id（不含）
 * @param {number} windowStartId 滑窗起点消息 id（不含）
 */
export async function getMessagesToSummarize(conversationId, uptoId, windowStartId) {
  const rows = await query(
    `SELECT id, role, content FROM messages
     WHERE conversation_id = ? AND id > ? AND id < ?
     ORDER BY id ASC`,
    [conversationId, uptoId, windowStartId]
  )
  return rows
}

/**
 * 写入新摘要，并把覆盖点推进到已摘要的最后一条消息 id
 * @param {number} conversationId
 * @param {string} summary 新摘要正文
 * @param {number} uptoId 本次摘要覆盖到的消息 id
 */
export async function saveConversationSummary(conversationId, summary, uptoId) {
  await query(
    'UPDATE conversations SET summary = ?, summary_upto_id = ? WHERE id = ?',
    [summary, uptoId, conversationId]
  )
}

/**
 * 删除会话及其全部消息（事务保证一致性）
 * @param {number} conversationId
 * @param {number} userId
 * @returns {Promise<boolean>} 是否删除成功（false = 不属于该用户）
 */
export async function deleteConversation(conversationId, userId) {
  // 先校验归属（防止删别人的会话）
  const conv = await getConversation(conversationId, userId)
  if (!conv) return false

  // 事务：先删消息，再删会话
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute('DELETE FROM messages WHERE conversation_id = ?', [conversationId])
    await conn.execute('DELETE FROM conversations WHERE id = ?', [conversationId])
    await conn.commit()
    return true
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
