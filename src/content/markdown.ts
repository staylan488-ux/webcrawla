function escapeHtml(s: string): string {
  return s
    // Strip C0 control characters (except \n and \t) before anything else so
    // literal \x01/\x02 bytes in model text can never be mistaken for a
    // stash placeholder token (see PH_OPEN/PH_CLOSE below).
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
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
// plausibly contain (escapeHtml strips them), so it cannot collide with
// literal digits in the input.
const PH_OPEN = '\x01'
const PH_CLOSE = '\x02'

function stash(html: string, placeholders: string[]): string {
  const i = placeholders.length
  placeholders.push(html)
  return `${PH_OPEN}${i}${PH_CLOSE}`
}

// Placeholders can nest (e.g. a stashed anchor whose label contains a stashed
// code-span placeholder), so a single replacement pass would leave inner
// tokens un-resolved. Repeat until no tokens remain, bounded so a malformed
// or forged token can never cause an infinite loop. Any token that still
// doesn't resolve (out-of-range index, or the loop bound was hit) is dropped
// rather than rendered as the literal string "undefined".
function unstash(text: string, placeholders: string[]): string {
  let s = text
  const maxIterations = placeholders.length + 1
  for (let i = 0; i < maxIterations && /\x01\d+\x02/.test(s); i++) {
    s = s.replace(/\x01(\d+)\x02/g, (_m, idx: string) => {
      const html = placeholders[Number(idx)]
      return html === undefined ? '' : html
    })
  }
  return s.replace(/\x01\d+\x02/g, '')
}

// Applies bold/em to plain text. Used both for the final pass over the whole
// string and for link labels captured before stashing, so `[**b**](url)`
// renders bold text inside the anchor without bold/em ever seeing (and
// mangling) an unstashed href value.
function emphasize(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

function inline(text: string, citations: Map<number, string>): string {
  const placeholders: string[] = []
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, (_m, code: string) =>
    stash(`<code>${code}</code>`, placeholders),
  )
  s = s.replace(
    /\[([^\]]+)\]\(([^)]*)\)/g,
    (_m, label: string, url: string) => {
      if (HTTP_URL.test(url)) {
        return stash(
          `<a href="${url}" target="_blank" rel="noopener">${emphasize(label)}</a>`,
          placeholders,
        )
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
  s = emphasize(s)
  return unstash(s, placeholders)
}

function renderBlock(block: string, citations: Map<number, string>): string {
  const t = block.trim()
  if (!t) return ''
  if (t.startsWith('```')) {
    const code = t.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')
    return `<pre><code>${escapeHtml(code)}</code></pre>`
  }
  const lines = t.split('\n')
  const HEADING_RE = /^(#{1,4})\s+(.*)$/
  const UL_RE = /^\s*[-*]\s+/
  const OL_RE = /^\s*\d+[.)]\s+/

  const pieces: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const heading = line.match(HEADING_RE)
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6)
      pieces.push(`<h${level}>${inline(heading[2], citations)}</h${level}>`)
      i++
      continue
    }
    if (UL_RE.test(line)) {
      const items: string[] = []
      while (i < lines.length && UL_RE.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(UL_RE, ''), citations)}</li>`)
        i++
      }
      pieces.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (OL_RE.test(line)) {
      const items: string[] = []
      while (i < lines.length && OL_RE.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(OL_RE, ''), citations)}</li>`)
        i++
      }
      pieces.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    const paraLines: string[] = []
    while (
      i < lines.length &&
      !HEADING_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    pieces.push(`<p>${inline(paraLines.join(' '), citations)}</p>`)
  }
  return pieces.join('')
}

export function renderMarkdown(md: string, citationUrls: Map<number, string>): string {
  return md
    .split(/\n{2,}/)
    .map(block => renderBlock(block, citationUrls))
    .join('')
}
