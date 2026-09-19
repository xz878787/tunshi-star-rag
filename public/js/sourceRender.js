// ==================== 检索来源渲染 ====================
// 把检索来源区渲染为消息 div 的尾部（历史回放与流式共用）

export function renderSources(div, sources) {
  if (!sources || sources.length === 0) return
  const wrap = document.createElement('div')
  wrap.className = 'sources'
  let html = '<details><summary>查看检索来源</summary>'
  sources.forEach((s) => {
    if (s.url) {
      // 联网来源：网站图标（无则 🌐）+ 来源网站名 + 可点击链接 + 发布时间（URL 做基本转义防注入）
      const safeUrl = String(s.url).replace(/"/g, '&quot;')
      const safeIcon = s.siteIcon ? String(s.siteIcon).replace(/"/g, '&quot;') : ''
      const iconHtml = safeIcon
        ? `<img class="site-icon" src="${safeIcon}" alt="" onerror="this.outerHTML='🌐'">`
        : '🌐'
      // 发布时间格式化：2026-09-17T08:30:00.000Z → 2026-09-17 08:30:00（截取到秒、T 换空格）
      const timeText = s.dateLastCrawled ? String(s.dateLastCrawled).slice(0, 19).replace('T', ' ') : ''
      const timeHtml = timeText ? `<div class="source-time">发布时间：${timeText}</div>` : ''
      html += `<div class="source-item">
<strong>${iconHtml} ${s.siteName || '网络来源'}</strong> <a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a>
${s.content}${timeHtml}
</div>`
    } else {
      // 库内来源：章节号 + 相似度（与原格式一致）
      html += `<div class="source-item">
<strong>[第${s.chapter}章]</strong> 相似度: ${s.score}
${s.content}
</div>`
    }
  })
  html += '</details>'
  wrap.innerHTML = html
  div.appendChild(wrap)
}
