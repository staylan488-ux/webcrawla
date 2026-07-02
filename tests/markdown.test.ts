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
  it('does not let bold/em markup inside a url leak into the href attribute', () => {
    const html = renderMarkdown('[a](https://x.com/**b**)', new Map())
    expect(html).toContain('href="https://x.com/**b**"')
    const hrefMatch = html.match(/href="([^"]*)"/)
    expect(hrefMatch?.[1]).not.toContain('<strong>')
  })
  it('resolves nested stash placeholders (code span inside a link label)', () => {
    const html = renderMarkdown('[`code`](https://x.com)', new Map())
    expect(html).toBe(
      '<p><a href="https://x.com" target="_blank" rel="noopener"><code>code</code></a></p>',
    )
    expect(html).not.toContain('\x01')
  })
  it('renders bold markup inside a link label', () => {
    const html = renderMarkdown('[**b**](https://x.com)', new Map())
    expect(html).toContain('<strong>b</strong>')
  })
  it('drops forged placeholder tokens instead of interpreting them', () => {
    const html = renderMarkdown('[good](https://good.com) \x010\x02 and \x0199\x02', new Map())
    expect(html).not.toContain('\x01')
    expect(html).not.toContain('undefined')
    expect(html.match(/<a /g)?.length).toBe(1)
  })
  it('renders a heading followed by a paragraph on the next line', () => {
    expect(renderMarkdown('### Title\nBody text', new Map())).toBe(
      '<h5>Title</h5><p>Body text</p>',
    )
  })
  it('renders a heading followed by an ordered list on the next lines', () => {
    expect(renderMarkdown('### Cycle\n1. one\n2. two', new Map())).toBe(
      '<h5>Cycle</h5><ol><li>one</li><li>two</li></ol>',
    )
  })
  it('renders an intro paragraph line followed by an unordered list', () => {
    expect(renderMarkdown('intro line\n- a\n- b', new Map())).toBe(
      '<p>intro line</p><ul><li>a</li><li>b</li></ul>',
    )
  })
  it('resolves citations inside headings and lists split by single newlines', () => {
    const html = renderMarkdown('### H\nfact [1]', new Map([[1, 'https://x.com']]))
    expect(html).toContain('<h5>H</h5>')
    expect(html).toContain('<sup class="cite">')
  })
  it('renders a GFM table with a header separator', () => {
    const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |', new Map())
    expect(html).toBe(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    )
  })
  it('treats alignment-colon separators as separators', () => {
    const html = renderMarkdown('| A | B |\n|:---|---:|\n| 1 | 2 |', new Map())
    expect(html).toBe(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    )
  })
  it('renders a table preceded by a heading, joined by single newlines', () => {
    const html = renderMarkdown('### Key\n| A | B |\n|---|---|\n| 1 | 2 |', new Map())
    expect(html).toBe(
      '<h5>Key</h5><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    )
  })
  it('renders citations and bold inside table cells', () => {
    const html = renderMarkdown('| **X** [1] |\n|---|\n| y |', new Map([[1, 'https://x.com']]))
    expect(html).toContain('<strong>X</strong>')
    expect(html).toContain('<sup class="cite">')
  })
  it('escapes raw HTML inside table cells', () => {
    const html = renderMarkdown('| <script> |\n|---|\n| y |', new Map())
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
  it('renders all rows in tbody when there is no separator line', () => {
    const html = renderMarkdown('| A | B |\n| 1 | 2 |', new Map())
    expect(html).toBe(
      '<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></tbody></table>',
    )
    expect(html).not.toContain('<thead>')
  })
  it('renders a lone pipe-containing line without leading/trailing pipes as a paragraph', () => {
    expect(renderMarkdown('a | b', new Map())).toBe('<p>a | b</p>')
  })
})
