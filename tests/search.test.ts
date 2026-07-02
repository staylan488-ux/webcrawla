import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDdgSerp } from '../src/offscreen/serp-parse-core'
import { searchWeb } from '../src/background/search'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const DDG_HTML = `<html><body>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fodds&amp;rut=abc">Belgium vs USA odds</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fodds">Belgium open as slight favorites…</a>
</div>
<div class="result result--ad">
  <h2 class="result__title"><a class="result__a" href="https://ads.example.com/x">Sponsored thing</a></h2>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a class="result__a" href="https://plain.example.org/preview">Direct link result</a></h2>
  <div class="result__snippet">A plain absolute link.</div>
</div>
</body></html>`

describe('parseDdgSerp', () => {
  it('extracts results, unwraps uddg redirects, skips ads', () => {
    const results = parseDdgSerp(DDG_HTML)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Belgium vs USA odds',
      url: 'https://example.com/odds',
      snippet: 'Belgium open as slight favorites…',
    })
    expect(results[1].url).toBe('https://plain.example.org/preview')
  })
  it('returns empty array on a page with no results', () => {
    expect(parseDdgSerp('<html><body><p>no results</p></body></html>')).toEqual([])
  })
  it('caps at 5 results', () => {
    const block = (i: number) => `<div class="result"><h2 class="result__title"><a class="result__a" href="https://e.com/${i}">R${i}</a></h2><div class="result__snippet">s${i}</div></div>`
    const html = `<html><body>${Array.from({ length: 8 }, (_, i) => block(i)).join('')}</body></html>`
    expect(parseDdgSerp(html)).toHaveLength(5)
  })
})

describe('searchWeb', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      offscreen: { hasDocument: async () => true, createDocument: vi.fn() },
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: true, results: [{ title: 'T', url: 'https://t.com', snippet: 's' }] })),
      },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('routes to DDG by default (fetch + offscreen parse)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })))
    const results = await searchWeb('belgium odds', { ...DEFAULT_SETTINGS })
    expect(results).toEqual([{ title: 'T', url: 'https://t.com', snippet: 's' }])
    const url = (fetch as any).mock.calls[0][0] as string
    expect(url).toContain('html.duckduckgo.com/html/?q=belgium%20odds')
  })

  it('falls back to DDG when perplexity is selected without a key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })))
    await searchWeb('q', { ...DEFAULT_SETTINGS, searchProvider: 'perplexity', perplexityApiKey: '' })
    expect(((fetch as any).mock.calls[0][0] as string)).toContain('duckduckgo.com')
  })

  it('calls the Perplexity Search API and maps results', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: 'Odds page', url: 'https://odds.example.com', snippet: 'x'.repeat(500) },
        { title: 'Bad', url: 'ftp://nope' },
      ],
    }), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const results = await searchWeb('belgium odds', { ...DEFAULT_SETTINGS, searchProvider: 'perplexity', perplexityApiKey: 'pplx-key' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.perplexity.ai/search')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer pplx-key')
    expect(JSON.parse(init.body as string)).toEqual({ query: 'belgium odds', max_results: 5 })
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://odds.example.com')
    expect(results[0].snippet.length).toBeLessThanOrEqual(300)
  })

  it('throws on a Perplexity non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))
    await expect(
      searchWeb('q', { ...DEFAULT_SETTINGS, searchProvider: 'perplexity', perplexityApiKey: 'bad' }),
    ).rejects.toThrow(/401/)
  })

  it('throws when the DDG fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 403 })))
    await expect(searchWeb('q', { ...DEFAULT_SETTINGS })).rejects.toThrow(/search fetch failed/)
  })
})
