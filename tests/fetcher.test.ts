import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPage } from '../src/background/fetcher'

afterEach(() => vi.unstubAllGlobals())

const htmlResponse = (body: string, type = 'text/html') =>
  new Response(body, { status: 200, headers: { 'content-type': type } })

describe('fetchPage', () => {
  it('returns html for a successful fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html><body>hi</body></html>')))
    const r = await fetchPage('https://example.com')
    expect(r).toEqual({ ok: true, html: '<html><body>hi</body></html>' })
  })
  it('rejects non-html content types', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('%PDF-1.4', 'application/pdf')))
    const r = await fetchPage('https://example.com/doc.pdf')
    expect(r.ok).toBe(false)
  })
  it('returns error on http failure status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })))
    const r = await fetchPage('https://example.com')
    expect(r).toEqual({ ok: false, error: 'HTTP 403' })
  })
  it('returns error when fetch throws (network/abort)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }))
    const r = await fetchPage('https://example.com')
    expect(r.ok).toBe(false)
  })
  it('rejects non-http urls without fetching', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const r = await fetchPage('javascript:alert(1)')
    expect(r.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
  it('caps html size', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('x'.repeat(3_000_000))))
    const r = await fetchPage('https://example.com')
    expect(r.ok && r.html.length <= 1_500_000).toBe(true)
  })
})
