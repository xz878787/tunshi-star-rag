// ==================== RAG API：SSE 流式请求 ====================
// 重点：SSE 解析逻辑与原内联代码完全一致，一行不改
// marked 是 CDN 加载的全局变量，直接使用

import { authHeaders, getToken } from './utils.js'
import { chatState, addMessage, addTyping, removeTyping, createMessage, attachThinkPanel, appendThink, finalizeThink } from './chat.js'
import { renderSources } from './sourceRender.js'
import { handleUnauthorized, loadConversations, newConversation } from './conversation.js'

// 流式解析后端推送：NDJSON 事件流，每行一个 JSON 事件
// 事件顺序：meta（会话）→ think…（思考步骤）→ sources（检索来源）→ token…（正文）→ done（总用时）
async function streamAnswer(res) {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder('utf-8') // 关键：把被切断的中文字节拼回完整字符
  let buffer = ''
  let refs = null        // { div, bubble, thinkBox, thinkBody, ... }
  let answerText = ''    // token 事件累积的正文
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 按行切分事件（JSON.stringify 保证每行是完整 JSON，内部换行已转义）
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let evt
        try { evt = JSON.parse(line) } catch (e) { continue } // 容错：跳过坏行

        if (evt.type === 'meta') {
          // 记录会话 id，供后续追问挂在同一会话；创建消息容器 + 思考面板
          if (evt.conversationId) chatState.currentConversationId = Number(evt.conversationId)
          refs = createMessage('assistant', '', [])
          attachThinkPanel(refs)
        } else if (evt.type === 'think') {
          appendThink(refs, evt.text) // 思考中：面板保持展开
        } else if (evt.type === 'sources') {
          renderSources(refs?.div, evt.sources) // 来源区渲染在气泡下方
        } else if (evt.type === 'token' && refs) {
          finalizeThink(refs)                 // 正文开始 → 停止思考动画（面板保持展开）
          answerText += evt.text
          refs.bubble.innerHTML = marked.parse(answerText)
        } else if (evt.type === 'done') {
          finalizeThink(refs)                 // 兜底：无正文的极端情况也收尾
        }
        chatState.chatArea.scrollTop = chatState.chatArea.scrollHeight
      }
    }
    // 刷新解码器末尾残留的字节
    buffer += decoder.decode()
  } catch (e) {
    // 中断/断网：保留已生成的半截内容，避免整段丢失
    if (refs?.bubble) refs.bubble.innerHTML = marked.parse(answerText || '（响应中断）')
    finalizeThink(refs)
  }
}

// 发送问题（完整请求 → 流式解析 → 刷新侧边栏）
export async function sendQuestion() {
  const question = chatState.input.value.trim()
  if (!question || chatState.loading) return
  if (!getToken()) {
    // 跨模块回调：main.js 注入的 showLogin
    if (typeof window.__ragShowLogin === 'function') {
      window.__ragShowLogin('请先登录后再使用问答功能')
    }
    return
  }

  chatState.loading = true
  chatState.input.value = ''
  chatState.sendBtn.disabled = true

  addMessage('user', question)
  addTyping()

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ question, conversationId: chatState.currentConversationId }),
    })
    if (res.status === 401) {
      // token 失效，踢回登录（统一处理）
      removeTyping()
      handleUnauthorized()
      chatState.loading = false
      chatState.sendBtn.disabled = false
      chatState.input.focus()
      return
    }

    const contentType = res.headers.get('content-type') || ''
    removeTyping()

    if (contentType.includes('application/json')) {
      // 兼容后端返回 JSON 的情况（如参数错误、500）
      const data = await res.json()
      if (data.conversationId) chatState.currentConversationId = data.conversationId
      addMessage('assistant', data.answer || data.error || '服务异常，请稍后重试', data.sources)
    } else {
      // 正常：先解析 meta 行拿 conversationId + sources，再流式渲染正文
      await streamAnswer(res)
    }
    // 刷新侧边栏（可能是新会话）
    loadConversations()
  } catch (e) {
    removeTyping()
    addMessage('assistant', '网络错误，请检查服务器是否运行。')
  }

  chatState.loading = false
  chatState.sendBtn.disabled = false
  chatState.input.focus()
}
