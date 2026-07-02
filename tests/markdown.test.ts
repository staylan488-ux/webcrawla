import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/content/markdown'

const cites = new Map([[1, 'https://example.com/a'], [2, 'https://example.org/b']])

describe('renderMarkdown', () => {
  it('escapes raw HTML from model output', () => {
    const html = renderMarkdown('hello <script>alert(1)</script>', new Map())
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
  it('renders paragraphs, bold, italic, inline code', () => {
    const html = renderMarkdown('some **bold** and *em* and `code`', new Map())
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>em</em>')
    expect(html).toContain('<code>code</code>')
    expect(html.startsWith('<p>')).toBe(true)
  })
  it('renders unordered and ordered lists', () => {
    expect(renderMarkdown('- one\n- two', new Map())).toBe('<ul><li>one</li><li>two</li></ul>')
    expect(renderMarkdown('1. one\n2. two', new Map())).toBe('<ol><li>one</li><li>two</li></ol>')
  })
  it('renders headings clamped small', () => {
    expect(renderMarkdown('## Heading', new Map())).toBe('<h4>Heading</h4>')
  })
  it('renders fenced code blocks with escaping', () => {
    const html = renderMarkdown('```\nconst a = 1 < 2\n```', new Map())
    expect(html).toBe('<pre><code>const a = 1 &lt; 2</code></pre>')
  })
  it('links [n] citations to source urls', () => {
    const html = renderMarkdown('Heat pumps move heat [1] efficiently [2].', cites)
    expect(html).toContain('<sup class="cite"><a href="https://example.com/a"')
    expect(html).toContain('>2</a></sup>')
  })
  it('leaves unknown citation numbers as text', () => {
    expect(renderMarkdown('claim [7]', cites)).toContain('[7]')
  })
  it('only allows http(s) urls in markdown links', () => {
    const html = renderMarkdown('[x](javascript:alert(1)) and [y](https://ok.com)', new Map())
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="https://ok.com"')
  })
  it('only allows http(s) urls in citation links', () => {
    const evilCites = new Map([[1, 'javascript:alert(1)']])
    const html = renderMarkdown('claim [1]', evilCites)
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('href')
    expect(html).toContain('[1]')
  })
  it('does not let citation regex corrupt a link href generated earlier', () => {
    const html = renderMarkdown('[a](https://x.com/[1])', cites)
    expect(html).toBe('<p><a href="https://x.com/[1]" target="_blank" rel="noopener">a</a></p>')
  })
  it('leaves [n] literal inside code spans instead of citation-linking it', () => {
    const html = renderMarkdown('`[1]`', cites)
    expect(html).toBe('<p><code>[1]</code></p>')
    expect(html).not.toContain('cite')
  })
})
