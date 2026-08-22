// ==================== 用户数据访问层 (Model) ====================
// 只负责 sys_user 表的增删查，不写业务逻辑
import { query } from './db.js'

/**
 * 按用户名查找用户
 * @param {string} username
 * @returns {Promise<Object|null>} 用户对象或 null
 */
export async function findUserByUsername(username) {
  const rows = await query('SELECT * FROM sys_user WHERE username = ?', [username])
  return rows[0] || null
}

/**
 * 创建新用户（密码已由上层 bcrypt 加密）
 * @param {Object} user { username, passwordHash, nickname }
 * @returns {Promise<Object>} 插入后的 id
 */
export async function createUser({ username, passwordHash, nickname = '' }) {
  const result = await query(
    'INSERT INTO sys_user (username, password, nickname) VALUES (?, ?, ?)',
    [username, passwordHash, nickname]
  )
  return { id: result.insertId }
}
