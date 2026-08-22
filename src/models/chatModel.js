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
 * @returns {Promise<Object>} 插入后的 { id }
 */
export async function appendMessage(conversationId, role, content, sources = null) {
  const result = await query(
    'INSERT INTO messages (conversation_id, role, content, sources) VALUES (?, ?, ?, ?)',
    [conversationId, role, content, sources ? JSON.stringify(sources) : null]
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
 * @returns {Promise<Array>} 消息列表（sources 已解析为对象）
 */
export async function getMessages(conversationId) {
  const rows = await query(
    'SELECT id, role, content, sources, create_time FROM messages WHERE conversation_id = ? ORDER BY create_time ASC, id ASC',
    [conversationId]
  )
  return rows.map((m) => ({
    ...m,
    sources: m.sources ? (typeof m.sources === 'string' ? JSON.parse(m.sources) : m.sources) : null,
  }))
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
