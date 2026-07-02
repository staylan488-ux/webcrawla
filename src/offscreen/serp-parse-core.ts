import type { SerpResult } from '../shared/types'

const MAX_RESULTS = 5

// DDG's html endpoint wraps result links as //duckduckgo.com/l/?uddg=<encoded>&…
function unwrapDdgRedirect(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    // searchParams.get already percent-decodes the value once — a second
    // decodeURIComponent would corrupt target URLs containing literal %XX.
    const uddg = url.searchParams.get('uddg')
    if (uddg) return uddg
    return href
  } catch {
    return href
  }
}

export function parseDdgSerp(html: string): SerpResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out: SerpResult[] = []
  for (const block of Array.from(doc.querySelectorAll('.result'))) {
    if (block.classList.contains('result--ad')) continue
    const link = block.querySelector('a.result__a')
    const href = link?.getAttribute('href') ?? ''
    if (!link || !href) continue
    const url = unwrapDdgRedirect(href)
    if (!/^https?:\/\//i.test(url)) continue
    const title = (link.textContent ?? '').trim()
    if (!title) continue
    const snippet = (block.querySelector('.result__snippet')?.textContent ?? '').trim()
    out.push({ title, url, snippet })
    if (out.length >= MAX_RESULTS) break
  }
  return out
}
