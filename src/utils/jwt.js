// ==================== JWT 工具封装 ====================
// 统一封装 jsonwebtoken，让业务层不直接依赖第三方库
import jwt from 'jsonwebtoken'

// 生产环境务必通过环境变量注入！这里给默认值仅为开发雏形兜底
const JWT_SECRET = process.env.JWT_SECRET || 'your_strong_secret_key_2026'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h'

/**
 * 签发 token
 * @param {Object} payload 业务载荷（userId, username, role 等，不放敏感密码）
 * @returns {string} accessToken
 */
export function signToken(payload) {
    // 剔除敏感字段，只保留非隐私信息
    const safePayload = { ...payload }
    delete safePayload.password
    return jwt.sign(safePayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

/**
 * 校验 token
 * @param {string} token
 * @returns {Object} 解析出的载荷（校验失败会 throw，由调用方捕获）
 */
export function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET)
}
