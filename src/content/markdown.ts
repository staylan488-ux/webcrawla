function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(text: string, citations: Map<number, string>): string {
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(
    /\[([^\]]+)\]\(([^)]*)\)/g,
    (_m, label: string, url: string) => {
      if (/^https?:\/\//.test(url)) {
        return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`
      }
      return label
    },
  )
  s = s.replace(/\[(\d{1,2})\]/g, (m, n: string) => {
    const url = citations.get(Number(n))
    if (!url) return m
    return `<sup class="cite"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${n}</a></sup>`
  })
  return s
}

function renderBlock(block: string, citations: Map<number, string>): string {
  const t = block.trim()
  if (!t) return ''
  if (t.startsWith('```')) {
    const code = t.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')
    return `<pre><code>${escapeHtml(code)}</code></pre>`
  }
  const heading = t.match(/^(#{1,4})\s+(.*)$/)
  if (heading && !t.includes('\n')) {
    const level = Math.min(heading[1].length + 2, 6)
    return `<h${level}>${inline(heading[2], citations)}</h${level}>`
  }
  const lines = t.split('\n')
  if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
    return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''), citations)}</li>`).join('')}</ul>`
  }
  if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) {
    return `<ol>${lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''), citations)}</li>`).join('')}</ol>`
  }
  return `<p>${inline(t, citations)}</p>`
}

export function renderMarkdown(md: string, citationUrls: Map<number, string>): string {
  return md
    .split(/\n{2,}/)
    .map(block => renderBlock(block, citationUrls))
    .join('')
}
