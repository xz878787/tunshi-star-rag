// ==================== 入口模块 ====================
// 只做三件事：
//   1) 从 HTML 查 DOM 节点，注入各模块的 refs 对象
//   2) 绑定所有事件监听（按钮点击 / Enter 提交 / 侧边栏折叠 / 自动播放）
//   3) 按正确顺序执行初始化（initSidebar → checkAuthOnLoad → initMedia）
// 不写业务逻辑——所有业务逻辑在各子模块中

import { chatState } from './chat.js'
import { authRefs, setOnLogoutRefresh, handleAuthAction, toggleMode, doLogout, checkAuthOnLoad } from './auth.js'
import { convRefs, setShowLogin, initSidebar, toggleSidebar, renderConversations, loadConversations, newConversation } from './conversation.js'
import { mediaRefs, toggleMusic, tryAutoPlay, initMedia } from './media.js'
import { sendQuestion } from './ragApi.js'

// ==================== 1) DOM 注入 ====================

// chat.js
chatState.chatArea = document.getElementById('chatArea')
chatState.input = document.getElementById('questionInput')
chatState.sendBtn = document.getElementById('sendBtn')

// auth.js
authRefs.loginOverlay = document.getElementById('loginOverlay')
authRefs.loginBtn = document.getElementById('loginBtn')
authRefs.loginUsername = document.getElementById('loginUsername')
authRefs.loginPassword = document.getElementById('loginPassword')
authRefs.loginError = document.getElementById('loginError')
authRefs.userBar = document.getElementById('userBar')
authRefs.userNameEl = document.getElementById('userName')
authRefs.userAvatarEl = document.getElementById('userAvatar')
authRefs.logoutBtn = document.getElementById('logoutBtn')
authRefs.loginTitle = document.getElementById('loginTitle')
authRefs.loginSub = document.getElementById('loginSub')
authRefs.confirmField = document.getElementById('confirmField')
authRefs.loginConfirm = document.getElementById('loginConfirm')
authRefs.loginHint = document.getElementById('loginHint')
authRefs.loginToggle = document.getElementById('loginToggle')
authRefs.toggleLink = document.getElementById('toggleLink')

// conversation.js
convRefs.sidebar = document.getElementById('sidebar')
convRefs.appLayout = document.querySelector('.app-layout')
convRefs.sidebarToggle = document.getElementById('sidebarToggle')
convRefs.convList = document.getElementById('convList')
convRefs.convEmpty = document.getElementById('convEmpty')
convRefs.newChatBtn = document.getElementById('newChatBtn')

// media.js
mediaRefs.bgm = document.getElementById('bgm')
mediaRefs.musicBtn = document.getElementById('musicBtn')
mediaRefs.bgSlider = document.getElementById('bgSlider')

// ==================== 2) 跨模块回调 wiring ====================

// auth → conversation：登出后刷新侧边栏
setOnLogoutRefresh(renderConversations)

// conversation → auth：401 时弹登录面板（showLogin 是 auth.js 的函数）
import { showLogin } from './auth.js'
setShowLogin(showLogin)

// auth.showLoggedIn 登录后 → conversation.loadConversations（auth 内通过 window.__authLoadConversations 调用）
window.__authLoadConversations = loadConversations

// ragApi → auth：sendQuestion 内判断未登录时调用 showLogin（通过 window 避免循环 import）
window.__ragShowLogin = showLogin

// ==================== 3) 事件绑定 ====================

// ---- 登录面板 ----
authRefs.loginBtn.addEventListener('click', handleAuthAction)
authRefs.loginPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleAuthAction()
})
authRefs.loginUsername.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') authRefs.loginPassword.focus()
})
authRefs.loginConfirm && authRefs.loginConfirm.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleAuthAction()
})
authRefs.toggleLink.addEventListener('click', toggleMode)
authRefs.logoutBtn.addEventListener('click', doLogout)

// ---- 聊天区 ----
chatState.sendBtn.addEventListener('click', sendQuestion)
chatState.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendQuestion()
})

// ---- 侧边栏 ----
convRefs.sidebarToggle.addEventListener('click', toggleSidebar)
convRefs.newChatBtn.addEventListener('click', newConversation)

// ---- 音乐 ----
mediaRefs.musicBtn.addEventListener('click', toggleMusic)

// 用户任意点击后尝试自动播放（浏览器自动播放限制）
document.addEventListener('click', tryAutoPlay, { once: true })

// ==================== 4) 初始化顺序 ====================

// 初始化折叠状态（在 checkAuthOnLoad 之前执行）
initSidebar()

// 检查登录状态（会自动 showLogin 或 showLoggedIn → loadConversations）
checkAuthOnLoad()

// 加载背景图片
initMedia()
