// ==================== 认证模块（登录 / 注册 / 登出）====================
// 跨模块回调：onLogoutRefresh 在 main.js 中注册为 conversation.renderConversations
// 避免 auth ↔ conversation 循环 import

import { getToken, getUserInfo, extractUserInfo, TOKEN_KEY, USER_KEY } from './utils.js'
import { chatState } from './chat.js'

// ===== DOM 引用（由 main.js 在加载时注入）=====
export const authRefs = {
  loginOverlay: null,
  loginBtn: null,
  loginUsername: null,
  loginPassword: null,
  loginError: null,
  userBar: null,
  userNameEl: null,
  userAvatarEl: null,
  logoutBtn: null,
  loginTitle: null,
  loginSub: null,
  confirmField: null,
  loginConfirm: null,
  loginHint: null,
  loginToggle: null,
  toggleLink: null,
}

// ===== 跨模块回调注册 =====
// main.js 在所有模块加载完后调用 setOnLogoutRefresh(conversation.renderConversations)
let onLogoutRefresh = null
export function setOnLogoutRefresh(fn) { onLogoutRefresh = fn }

// 登录/注册模式切换
let isRegisterMode = false

// 显示登录面板（自动切回登录模式）
export function showLogin(msg) {
  if (isRegisterMode) toggleMode()
  authRefs.loginOverlay.classList.add('active')
  authRefs.loginError.textContent = msg || ''
  authRefs.userBar.classList.remove('active')
  setTimeout(() => authRefs.loginUsername.focus(), 100)
}

// 隐藏登录面板并显示用户栏
export function showLoggedIn(userInfo) {
  authRefs.loginOverlay.classList.remove('active')
  authRefs.userBar.classList.add('active')
  if (userInfo) {
    authRefs.userNameEl.textContent = userInfo.username || '用户'
    authRefs.userAvatarEl.textContent = (userInfo.username || 'U').charAt(0).toUpperCase()
  }
  // 登录后加载历史会话列表（由 main.js 绑定为 conversation.loadConversations）
  if (typeof window.__authLoadConversations === 'function') {
    window.__authLoadConversations()
  }
}

// 登录/注册模式切换
export function toggleMode() {
  isRegisterMode = !isRegisterMode
  authRefs.loginError.textContent = ''
  if (isRegisterMode) {
    authRefs.loginTitle.textContent = '注册新账号'
    authRefs.loginSub.textContent = '注册后即可使用智能问答'
    authRefs.loginBtn.textContent = '注 册'
    authRefs.confirmField.classList.remove('hidden')
    authRefs.loginHint.classList.add('hidden')
    authRefs.toggleLink.textContent = '立即登录'
    authRefs.loginToggle.firstChild.textContent = '已有账号？'
  } else {
    authRefs.loginTitle.textContent = '吞噬星空 RAG 助手'
    authRefs.loginSub.textContent = '请登录后使用智能问答'
    authRefs.loginBtn.textContent = '登 录'
    authRefs.confirmField.classList.add('hidden')
    authRefs.loginHint.classList.remove('hidden')
    authRefs.toggleLink.textContent = '立即注册'
    authRefs.loginToggle.firstChild.textContent = '没有账号？'
  }
  authRefs.loginPassword.value = ''
  authRefs.loginConfirm && (authRefs.loginConfirm.value = '')
}

// 登录请求
async function doLogin() {
  const username = authRefs.loginUsername.value.trim()
  const password = authRefs.loginPassword.value
  if (!username || !password) {
    authRefs.loginError.textContent = '请输入用户名和密码'
    return
  }
  authRefs.loginBtn.disabled = true
  authRefs.loginError.textContent = ''
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await res.json()
    if (data.code === 200 && data.data?.accessToken) {
      localStorage.setItem(TOKEN_KEY, data.data.accessToken)
      const userInfo = extractUserInfo(data.data.accessToken)
      localStorage.setItem(USER_KEY, JSON.stringify(userInfo))
      showLoggedIn(userInfo)
      chatState.chatArea?.scrollTo && chatState.chatArea.scrollTop !== undefined && (chatState.chatArea.scrollTop = chatState.chatArea.scrollHeight)
    } else {
      authRefs.loginError.textContent = data.msg || '登录失败，请检查账号密码'
    }
  } catch (e) {
    authRefs.loginError.textContent = '网络错误，请检查服务器是否运行'
  } finally {
    authRefs.loginBtn.disabled = false
  }
}

// 注册请求
async function doRegister() {
  const username = authRefs.loginUsername.value.trim()
  const password = authRefs.loginPassword.value
  const confirm = authRefs.loginConfirm.value
  if (!username || !password) {
    authRefs.loginError.textContent = '请输入用户名和密码'
    return
  }
  if (password.length < 6) {
    authRefs.loginError.textContent = '密码长度至少 6 位'
    return
  }
  if (password !== confirm) {
    authRefs.loginError.textContent = '两次密码不一致'
    return
  }
  authRefs.loginBtn.disabled = true
  authRefs.loginError.textContent = ''
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await res.json()
    if (data.code === 200) {
      // 注册成功 → 切回登录模式 + 自动填用户名 + 提示
      toggleMode()
      authRefs.loginUsername.value = username
      authRefs.loginPassword.value = ''
      authRefs.loginError.style.color = '#4ade80'
      authRefs.loginError.textContent = '注册成功，请登录'
      setTimeout(() => { authRefs.loginError.style.color = ''; authRefs.loginError.textContent = '' }, 3000)
    } else {
      authRefs.loginError.textContent = data.msg || '注册失败，请重试'
    }
  } catch (e) {
    authRefs.loginError.textContent = '网络错误，请检查服务器是否运行'
  } finally {
    authRefs.loginBtn.disabled = false
  }
}

// 统一入口：按钮点击根据模式分派
export function handleAuthAction() {
  if (isRegisterMode) doRegister()
  else doLogin()
}

// 退出登录
export function doLogout() {
  // <div class="bubble">
  //   你好！我是《吞噬星空》小说助手小志，你可以问我任何关于小说的问题。比如：<br><br>
  //    • 遁天梭是谁赠予罗峰的？<br>
  //    • 罗峰在虚拟宇宙公司内部有哪些角色？<br>
  //    • 罗峰什么时候正式离开地球前往了宇宙？<br>
  //         
  //   • 罗峰离开地球前往宇宙前发生了哪些大事？<br>
          
  // </div>
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  authRefs.loginPassword.value = ''
  // 清理会话状态，恢复聊天区初始欢迎语（与新对话保持一致）
  chatState.currentConversationId = null
  if (chatState.chatArea) chatState.chatArea.innerHTML = `
      <div class="message assistant">
        <div class="bubble">
          你好！我是《吞噬星空》小说助手小志，你可以问我任何关于小说的问题。比如：<br><br>
          • 罗峰突破界主后，那个时候他最厉害的师傅是谁，以及他的师傅是什么修为？<br>
          • 地球人类为什么必须集体撤离地球？从直接诱因和长期潜藏隐患两方面说明<br>
          • 巨斧创始者、巨斧、金角巨兽、金角族群，四者之间是什么关系，不要混淆<br>
          • 罗峰和唐三谁18岁更强，以及那个时候分别使用的是什么武器？
        </div>
      </div>`
  if (typeof onLogoutRefresh === 'function') onLogoutRefresh()
  showLogin('已退出登录，请重新登录')
}

// 页面加载时检查登录状态
export function checkAuthOnLoad() {
  const token = getToken()
  const userInfo = getUserInfo()
  if (!token) {
    showLogin()
    return
  }
  // 有 token，先展示用户栏（不阻塞加载），后端校验失败会自动踢回
  showLoggedIn(userInfo)
}
