// ==================== 对话状态 + 消息气泡渲染 + 思考面板 ====================
// marked 是 CDN 加载的全局变量，直接使用不 import

import { renderSources } from './sourceRender.js'

// 共享状态对象：其他模块（ragApi / auth / conversation）通过 chatState 读写
export const chatState = {
  chatArea: null,      // 主聊天区 DOM
  input: null,         // 问题输入框
  sendBtn: null,       // 发送按钮
  loading: false,      // 是否正在请求
  currentConversationId: null, // 当前打开的会话 id（null = 新对话）
}

// ========== 消息 DOM 构建 ==========

// 构造一条消息 DOM，返回 { div, bubble } 供流式逐步更新正文
export function createMessage(role, text, sources) {
  const div = document.createElement('div')
  div.className = `message ${role}`

  let bubbleHTML
  if (role === 'assistant') {
    bubbleHTML = marked.parse(text)
  } else {
    bubbleHTML = text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  div.innerHTML = `<div class="bubble">${bubbleHTML}</div>`
  renderSources(div, sources)

  chatState.chatArea.appendChild(div)
  chatState.chatArea.scrollTop = chatState.chatArea.scrollHeight
  return { div, bubble: div.querySelector('.bubble') }
}

export function addMessage(role, text, sources) {
  return createMessage(role, text, sources).div
}

export function addTyping() {
  const div = document.createElement('div')
  div.className = 'message assistant typing-indicator'
  div.innerHTML = '<div class="bubble typing"><span></span><span></span><span></span></div>'
  chatState.chatArea.appendChild(div)
  chatState.chatArea.scrollTop = chatState.chatArea.scrollHeight
}

export function removeTyping() {
  const indicator = document.querySelector('.typing-indicator')
  if (indicator) indicator.remove()
}

// ========== 思考过程折叠区（DeepSeek 风格）==========

// 在消息气泡上方插入「正在思考」面板：默认展开且完成后保留，可点击收起/再展开
export function attachThinkPanel(refs) {
  const box = document.createElement('div')
  box.className = 'think-box thinking'
  box.innerHTML = '<div class="think-toggle"><span class="think-status">正在思考</span><span class="think-caret">▶</span></div><div class="think-body"></div>'
  refs.div.insertBefore(box, refs.bubble)
  refs.thinkBox = box
  refs.thinkBody = box.querySelector('.think-body')
  refs.thinkStart = Date.now() // 思考计时起点
  refs.thinkDone = false
  refs.bubble.style.display = 'none' // 正文未开始前先隐藏空气泡
  box.querySelector('.think-toggle').addEventListener('click', () => {
    box.classList.toggle('collapsed')
  })
}

// 追加一行思考内容（自动滚到底部）
export function appendThink(refs, text) {
  if (!refs?.thinkBody) return
  const line = document.createElement('div')
  line.className = 'think-line'
  line.textContent = text
  refs.thinkBody.appendChild(line)
  refs.thinkBody.scrollTop = refs.thinkBody.scrollHeight
}

// 思考结束：停止「正在思考」动画，状态行变为「已完成思考（用时 X 秒）」
// 注意：不自动收起——思考内容默认保留展开，用户可点击标题手动收起/再展开
export function finalizeThink(refs) {
  if (!refs?.thinkBox || refs.thinkDone) return
  refs.thinkDone = true
  const sec = ((Date.now() - refs.thinkStart) / 1000).toFixed(1)
  refs.thinkBox.classList.remove('thinking')
  refs.thinkBox.querySelector('.think-status').textContent = `已完成思考（用时 ${sec} 秒）`
  refs.bubble.style.display = ''
}
