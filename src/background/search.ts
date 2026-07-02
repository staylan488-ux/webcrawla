import type { SerpResult, Settings } from '../shared/types'
import { ensureOffscreen } from './extract'
import { fetchPage } from './fetcher'

const MAX_RESULTS = 5
const SEARCH_TIMEOUT_MS = 6000
const SNIPPET_CAP = 300

export async function searchWeb(query: string, settings: Settings): Promise<SerpResult[]> {
  const usePerplexity = settings.searchProvider === 'perplexity' && settings.perplexityApiKey
  return usePerplexity ? searchPerplexity(query, settings.perplexityApiKey) : searchDdg(query)
}

async function searchDdg(query: string): Promise<SerpResult[]> {
  const r = await fetchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    timeoutMs: SEARCH_TIMEOUT_MS,
  })
  if (!r.ok) throw new Error(`search fetch failed: ${r.error}`)
  await ensureOffscreen()
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', kind: 'parse-serp', html: r.html })
  if (!res?.ok) throw new Error(res?.error ?? 'serp parse failed')
  return (res.results as SerpResult[]).slice(0, MAX_RESULTS)
}

async function searchPerplexity(query: string, apiKey: string): Promise<SerpResult[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.perplexity.ai/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: MAX_RESULTS }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Perplexity search failed (${res.status})`)
    const data = await res.json()
    return ((data.results ?? []) as Array<{ title?: string; url?: string; snippet?: string }>)
      .filter(r => typeof r.url === 'string' && /^https?:\/\//i.test(r.url))
      .slice(0, MAX_RESULTS)
      .map(r => ({
        title: (r.title || r.url) as string,
        url: r.url as string,
        snippet: (r.snippet ?? '').slice(0, SNIPPET_CAP),
      }))
  } finally {
    clearTimeout(timer)
  }
}
