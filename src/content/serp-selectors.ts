import type { SerpResult } from '../shared/types'

// All Startpage-specific selectors live here. If Startpage changes markup,
// update these candidates; the generic fallback below keeps us degraded-but-working.
const RESULT_CONTAINER_SELECTORS = [
  '.w-gl__result',
  '.result',
  'div[class*="result-item"]',
]

const SNIPPET_SELECTORS = ['[class*="description"]', '[class*="desc"]', 'p']

const MAX_RESULTS = 10

function isExternalHttpUrl(href: string): boolean {
  return /^https?:\/\//.test(href) && !href.includes('startpage.com')
}

function snippetIn(container: Element): string {
  for (const sel of SNIPPET_SELECTORS) {
    const text = container.querySelector(sel)?.textContent?.trim()
    if (text) return text
  }
  return ''
}

function extractFromContainer(el: Element): SerpResult | null {
  const link = Array.from(el.querySelectorAll('a[href]')).find(a =>
    isExternalHttpUrl(a.getAttribute('href') ?? ''),
  )
  if (!link) return null
  const url = link.getAttribute('href')!
  const heading = el.querySelector('h1, h2, h3, h4')
  const title = (heading?.textContent ?? link.textContent ?? '').trim()
  if (!title) return null
  return { title, url, snippet: snippetIn(el) }
}

function scrapeWithSelectors(root: ParentNode): SerpResult[] {
  for (const sel of RESULT_CONTAINER_SELECTORS) {
    const containers = Array.from(root.querySelectorAll(sel))
    const results = containers
      .map(extractFromContainer)
      .filter((r): r is SerpResult => r !== null)
    if (results.length >= 3) return results
  }
  return []
}

function scrapeFallback(root: ParentNode): SerpResult[] {
  const out: SerpResult[] = []
  for (const h of Array.from(root.querySelectorAll('h1, h2, h3'))) {
    const link =
      h.closest('a[href]') ??
      h.querySelector('a[href]') ??
      h.parentElement?.closest('a[href]') ??
      null
    const href = link?.getAttribute('href') ?? ''
    if (!isExternalHttpUrl(href)) continue
    const container = link!.closest('div, section, li, article') ?? h.parentElement
    out.push({
      title: (h.textContent ?? '').trim(),
      url: href,
      snippet: container?.querySelector('p')?.textContent?.trim() ?? '',
    })
  }
  return out
}

function dedupe(results: SerpResult[]): SerpResult[] {
  const seen = new Set<string>()
  return results
    .filter(r => {
      if (!r.title || seen.has(r.url)) return false
      seen.add(r.url)
      return true
    })
    .slice(0, MAX_RESULTS)
}

export function scrapeSerp(root: ParentNode): SerpResult[] {
  const viaSelectors = scrapeWithSelectors(root)
  return dedupe(viaSelectors.length ? viaSelectors : scrapeFallback(root))
}

export function findResultsAnchor(doc: Document): Element | null {
  for (const sel of RESULT_CONTAINER_SELECTORS) {
    const el = doc.querySelector(sel)
    if (el) return el
  }
  return doc.querySelector('main')?.firstElementChild ?? null
}
