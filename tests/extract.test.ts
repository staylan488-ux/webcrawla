import { describe, expect, it } from 'vitest'
import { extractReadable } from '../src/offscreen/extract-core'

const ARTICLE_HTML = `<!doctype html><html><head><title>Heat Pumps Explained</title></head><body>
<nav>Home | About | Contact</nav>
<article>
  <h1>Heat Pumps Explained</h1>
  ${'<p>A heat pump moves thermal energy from a cooler space to a warmer space using mechanical work. '.repeat(30)}</p>
</article>
<footer>Copyright 2026</footer>
</body></html>`

describe('extractReadable', () => {
  it('extracts title and article text', () => {
    const r = extractReadable(ARTICLE_HTML, 'https://example.com/heat-pumps', 8000)
    expect(r.title).toContain('Heat Pumps')
    expect(r.text).toContain('thermal energy')
  })
  it('truncates to the char budget', () => {
    const r = extractReadable(ARTICLE_HTML, 'https://example.com/heat-pumps', 500)
    expect(r.text.length).toBeLessThanOrEqual(501)
  })
  it('falls back to body text on non-article pages', () => {
    const r = extractReadable('<html><head><title>t</title></head><body><div>short plain content</div></body></html>', 'https://example.com', 8000)
    expect(r.text).toContain('short plain content')
  })
})
