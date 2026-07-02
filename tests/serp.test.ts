import { describe, expect, it } from 'vitest'
import { findResultsAnchor, scrapeSerp } from '../src/content/serp-selectors'

const KNOWN_MARKUP = `
<main>
  <div class="w-gl">
    <div class="w-gl__result">
      <a class="w-gl__result-title" href="https://example.com/a"><h3>Result A</h3></a>
      <p class="w-gl__description">Snippet about A</p>
    </div>
    <div class="w-gl__result">
      <a class="w-gl__result-title" href="https://example.org/b"><h3>Result B</h3></a>
      <p class="w-gl__description">Snippet about B</p>
    </div>
    <div class="w-gl__result">
      <a class="w-gl__result-title" href="https://example.net/c"><h3>Result C</h3></a>
      <p class="w-gl__description">Snippet about C</p>
    </div>
    <div class="w-gl__result">
      <a class="w-gl__result-title" href="https://www.startpage.com/settings"><h3>Internal</h3></a>
      <p class="w-gl__description">Should be skipped</p>
    </div>
    <div class="w-gl__result">
      <a class="w-gl__result-title" href="https://example.com/a"><h3>Duplicate A</h3></a>
      <p class="w-gl__description">Dup</p>
    </div>
  </div>
</main>`

const UNKNOWN_MARKUP = `
<main>
  <section><a href="https://alpha.dev/x"><h2>Alpha</h2></a><p>About alpha</p></section>
  <section><a href="https://beta.dev/y"><h2>Beta</h2></a><p>About beta</p></section>
  <section><a href="https://gamma.dev/z"><h2>Gamma</h2></a><p>About gamma</p></section>
</main>`

function docFrom(html: string): Document {
  document.body.innerHTML = html
  return document
}

describe('scrapeSerp', () => {
  it('extracts title, url, snippet from known markup', () => {
    const results = scrapeSerp(docFrom(KNOWN_MARKUP))
    expect(results[0]).toEqual({ title: 'Result A', url: 'https://example.com/a', snippet: 'Snippet about A' })
    expect(results).toHaveLength(3)
  })
  it('skips startpage-internal links and dedupes by url', () => {
    const urls = scrapeSerp(docFrom(KNOWN_MARKUP)).map(r => r.url)
    expect(urls).not.toContain('https://www.startpage.com/settings')
    expect(urls.filter(u => u === 'https://example.com/a')).toHaveLength(1)
  })
  it('falls back to generic heading+link detection on unknown markup', () => {
    const results = scrapeSerp(docFrom(UNKNOWN_MARKUP))
    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ title: 'Alpha', url: 'https://alpha.dev/x', snippet: 'About alpha' })
  })
  it('returns empty array on a page with no results', () => {
    expect(scrapeSerp(docFrom('<main><p>no results</p></main>'))).toEqual([])
  })
})

describe('findResultsAnchor', () => {
  it('returns the first result container on known markup', () => {
    const anchor = findResultsAnchor(docFrom(KNOWN_MARKUP))
    expect(anchor?.classList.contains('w-gl__result')).toBe(true)
  })
  it('returns main firstElementChild as fallback', () => {
    const anchor = findResultsAnchor(docFrom(UNKNOWN_MARKUP))
    expect(anchor?.tagName).toBe('SECTION')
  })
})
