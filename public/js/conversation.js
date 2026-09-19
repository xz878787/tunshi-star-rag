// ==================== 历史会话侧边栏 ====================
// handleUnauthorized 定义于此（清聊天区 + 刷侧边栏 + 弹登录），ragApi 会 import 它

import { authHeaders, SIDEBAR_KEY } from './utils.js'
import { chatState, addMessage, createMessage, attachThinkPanel, appendThink, finalizeThink } from './chat.js'

// ===== DOM 引用（由 main.js 在加载时注入）=====
export const convRefs = {
  sidebar: null,
  appLayout: null,
  sidebarToggle: null,
  convList: null,
  convEmpty: null,
  newChatBtn: null,
}

// ===== 跨模块回调：showLogin 由 auth.js 提供，main.js 注入 =====
let _showLogin = null
export function setShowLogin(fn) { _showLogin = fn }

// 当前打开的会话 id 与列表（chatState.currentConversationId 与之同步）
let conversations = []

// ========== 侧边栏折叠 ==========

export function initSidebar() {
  if (localStorage.getItem(SIDEBAR_KEY) === '1') {
    convRefs.appLayout.classList.add('sidebar-collapsed')
    convRefs.sidebarToggle.textContent = '☰'
  } else {
    convRefs.sidebarToggle.textContent = '✕'
  }
}

export function toggleSidebar() {
  const collapsed = convRefs.appLayout.classList.toggle('sidebar-collapsed')
  localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
  convRefs.sidebarToggle.textContent = collapsed ? '☰' : '✕'
}

// ========== 401 统一处理 ==========
// 清除登录态 + 清聊天区 + 刷侧边栏 + 弹登录（ragApi 也调用此函数）
export function handleUnauthorized() {
  localStorage.removeItem('tsxk_rag_token')
  localStorage.removeItem('tsxk_rag_user')
  chatState.currentConversationId = null
  chatState.chatArea.innerHTML = ''
  renderConversations()
  if (typeof _showLogin === 'function') _showLogin('登录已过期，请重新登录')
}

// ========== 会话 CRUD ==========

// 加载会话列表
export async function loadConversations() {
  try {
    const res = await fetch('/api/conversations', { headers: authHeaders() })
    if (res.status === 401) { handleUnauthorized(); return }
    const data = await res.json()
    conversations = (data.data || []).map(c => ({
      id: c.id,
      title: c.title || '新对话',
      update_time: c.update_time,
    }))
    renderConversations()
  } catch (e) {
    // 静默失败（比如服务器未启动），不影响主界面
  }
}

// 渲染侧边栏会话列表
export function renderConversations() {
  convRefs.convList.innerHTML = ''
  convRefs.convEmpty.style.display = conversations.length ? 'none' : 'block'
  conversations.forEach(c => {
    const item = document.createElement('div')
    item.className = 'conv-item' + (c.id === chatState.currentConversationId ? ' active' : '')
    item.innerHTML = `<span class="conv-title"></span><button class="conv-del" title="删除">🗑</button>`
    item.querySelector('.conv-title').textContent = c.title
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('conv-del')) {
        e.stopPropagation()
        deleteConversation(c.id)
        return
      }
      openConversation(c.id)
    })
    convRefs.convList.appendChild(item)
  })
}

// 打开某次会话（加载完整消息 + 思考面板）
export async function openConversation(id) {
  try {
    const res = await fetch(`/api/conversations/${id}`, { headers: authHeaders() })
    if (res.status === 401) { handleUnauthorized(); return }
    const data = await res.json()
    if (data.code !== 200) return
    chatState.currentConversationId = id
    chatState.chatArea.innerHTML = ''
    ;(data.data.messages || []).forEach(m => {
      if (m.role === 'user') { addMessage('user', m.content); return }
      // assistant 消息：先渲染正文与来源；若带已落库的思考过程 → 复现「已完成思考」面板
      const created = createMessage('assistant', m.content, m.sources)
      if (Array.isArray(m.thinking?.lines) && m.thinking.lines.length) {
        attachThinkPanel(created)
        m.thinking.lines.forEach(l => appendThink(created, l))
        // 直接收尾：不重新计时，用落库的思考用时
        created.thinkDone = true
        created.thinkBox.classList.remove('thinking')
        const sec = Number(m.thinking.seconds)
        created.thinkBox.querySelector('.think-status').textContent =
          (Number.isFinite(sec) && sec > 0) ? `已完成思考（用时 ${sec} 秒）` : '已完成思考'
        created.bubble.style.display = ''
      }
    })
    renderConversations()
    chatState.chatArea.scrollTop = chatState.chatArea.scrollHeight
  } catch (e) {
    // 静默失败
  }
}

// 新对话：清空 + 恢复初始欢迎语（与页面首次加载时的完整内容一致）
export function newConversation() {
  chatState.currentConversationId = null
  chatState.chatArea.innerHTML = ''
  renderConversations()
  // 欢迎语（与 index.html 静态气泡、auth.js 登录后欢迎语三处保持一致）
  const welcomeText = `你好！我是《吞噬星空》小说助手小志，你可以问我任何关于小说的问题。比如：<br><br>
    • 罗峰突破界主后，那个时候他最厉害的师傅是谁，以及他的师傅是什么修为？<br>
    • 地球人类为什么必须集体撤离地球？从直接诱因和长期潜藏隐患两方面说明<br>
    • 巨斧创始者、巨斧、金角巨兽、金角族群，四者之间是什么关系，不要混淆<br>
    • 罗峰和唐三谁18岁更强，以及那个时候分别使用的是什么武器？`
  addMessage('assistant', welcomeText)
  chatState.input.focus()
}

// 删除会话（含后端联动）
export async function deleteConversation(id) {
  if (!confirm('确定删除该会话？')) return
  try {
    const res = await fetch(`/api/conversations/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    if (res.status === 401) { handleUnauthorized(); return }
    const data = await res.json()
    if (data.code === 200) {
      if (chatState.currentConversationId === id) {
        chatState.currentConversationId = null
        chatState.chatArea.innerHTML = ''
        addMessage('assistant', '该会话已删除。')
      }
      loadConversations()
    }
  } catch (e) {
    // 静默失败
  }
}
