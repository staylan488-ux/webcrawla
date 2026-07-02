function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const HTTP_URL = /^https?:\/\//i

// Tag-producing transforms (code spans, links, citations) stash their generated
// HTML behind an opaque placeholder token so later transforms only ever scan
// plain text, never markup they themselves generated (which could contain
// `[n]`, stray quotes, etc. that would otherwise be reinterpreted). The token
// is wrapped in ASCII control characters (SOH/STX) that model text can never
// plausibly contain, so it cannot collide with literal digits in the input.
const PH_OPEN = '\x01'
const PH_CLOSE = '\x02'
const PLACEHOLDER_RE = /\x01(\d+)\x02/g

function stash(html: string, placeholders: string[]): string {
  const i = placeholders.length
  placeholders.push(html)
  return `${PH_OPEN}${i}${PH_CLOSE}`
}

function unstash(text: string, placeholders: string[]): string {
  return text.replace(PLACEHOLDER_RE, (_m, i: string) => placeholders[Number(i)])
}

function inline(text: string, citations: Map<number, string>): string {
  const placeholders: string[] = []
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, (_m, code: string) =>
    stash(`<code>${code}</code>`, placeholders),
  )
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(
    /\[([^\]]+)\]\(([^)]*)\)/g,
    (_m, label: string, url: string) => {
      if (HTTP_URL.test(url)) {
        return stash(`<a href="${url}" target="_blank" rel="noopener">${label}</a>`, placeholders)
      }
      return label
    },
  )
  s = s.replace(/\[(\d{1,2})\]/g, (m, n: string) => {
    const url = citations.get(Number(n))
    if (!url || !HTTP_URL.test(url)) return m
    return stash(
      `<sup class="cite"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${n}</a></sup>`,
      placeholders,
    )
  })
  return unstash(s, placeholders)
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
