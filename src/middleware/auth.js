// ==================== 鉴权中间件 ====================
// 拦截未认证请求，通过后把用户信息挂到 req.user
import { verifyToken } from '../utils/jwt.js'

/**
 * JWT 鉴权中间件
 * 规范格式：Authorization: Bearer xxxxxx
 */
export function authMiddleware(req, res, next) {
    // 1. 从请求头拿 token
    const authHeader = req.headers.authorization
    if (!authHeader) {
        return res.status(401).json({ code: 401, msg: '未提供身份令牌，请登录' })
    }

    // 2. 校验格式 Bearer xxx
    const [scheme, token] = authHeader.split(' ')
    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ code: 401, msg: '令牌格式错误，标准格式：Bearer token' })
    }

    // 3. 校验并解析 token
    try {
        const decoded = verifyToken(token)
        req.user = decoded  // 挂载用户信息，后续路由通过 req.user 读取
        next()              // 校验通过，放行
    } catch (err) {
        // 区分过期与非法两种情况
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ code: 401, msg: 'token已过期，请重新登录' })
        }
        return res.status(401).json({ code: 401, msg: '非法令牌，验证失败' })
    }
}
