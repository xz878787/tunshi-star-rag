// ==================== 公共工具模块 ====================
// 仅提供纯函数与常量，不访问 DOM、不依赖其他业务模块

export const TOKEN_KEY = 'tsxk_rag_token'
export const USER_KEY = 'tsxk_rag_user'
export const SIDEBAR_KEY = 'tsxk_rag_sidebar_collapsed'

// 获取已存的 token
export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

// 获取已存的用户信息
export function getUserInfo() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null')
  } catch {
    return null
  }
}

// 构造带 Authorization 的请求头
export function authHeaders() {
  const h = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) h.Authorization = 'Bearer ' + token
  return h
}

// 从 token 的 payload 中提取用户展示信息（不依赖外部库）
export function extractUserInfo(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    const { iat, exp, password, ...rest } = payload
    return rest
  } catch {
    return { username: 'admin' }
  }
}
