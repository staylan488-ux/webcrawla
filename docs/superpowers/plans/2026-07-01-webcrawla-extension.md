# Webcrawla Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chrome MV3 extension for Vivaldi that injects a BYOK AI answer card at the top of Startpage search results, grounded in a live parallel crawl of result pages with an LLM tool-calling loop.

**Architecture:** Content script scrapes the Startpage SERP DOM and renders a shadow-DOM panel; background service worker runs a "hybrid race" (parallel prefetch of top results + streaming OpenAI-compatible chat call with a `fetch_page` tool); an offscreen document does Readability text extraction (service workers have no DOM). Spec: `docs/superpowers/specs/2026-07-01-webcrawla-ai-overview-design.md`.

**Tech Stack:** TypeScript (strict), esbuild, vitest + jsdom, `@mozilla/readability` (only runtime dep), vanilla DOM.

## Global Constraints

- Manifest V3. `permissions`: `["storage", "offscreen"]`; `host_permissions`: `["<all_urls>"]`.
- Settings in `chrome.storage.local` only — never `sync`.
- Default endpoint `https://ollama.com/v1`; default model `glm-5.2`; both user-editable.
- Caps: 5 prefetch pages (default, configurable), 8 total pages, 3 tool rounds, 45s overall budget, 8,000 chars extracted per page (default, configurable).
- Model output rendered only through the sanitizing markdown renderer — never `innerHTML` of raw model text.
- No UI framework. Only runtime dependency: `@mozilla/readability`.
- All source under `src/`, tests under `tests/`, bundles to `dist/`.

## File Map

| File | Responsibility |
|---|---|
| `src/manifest.json` | MV3 manifest |
| `src/shared/types.ts` | Shared types, defaults, port protocol |
| `src/shared/settings.ts` | Load/save settings (`chrome.storage.local`) |
| `src/content/index.ts` | Content entrypoint: query, scrape, trigger, port wiring |
| `src/content/serp-selectors.ts` | SERP selectors + scraper + fallback + injection anchor |
| `src/content/trigger.ts` | Smart trigger heuristic |
| `src/content/markdown.ts` | Sanitizing markdown renderer + citation links |
| `src/content/panel.ts` | Shadow-DOM answer card (all states) |
| `src/background/index.ts` | Service worker: port handling, job runner |
| `src/background/agent.ts` | Hybrid race + tool loop orchestration |
| `src/background/llm.ts` | OpenAI-compatible streaming client (SSE + tool-call deltas) |
| `src/background/fetcher.ts` | Page fetch with timeout/size caps |
| `src/background/extract.ts` | Offscreen doc lifecycle + extraction RPC |
| `src/background/prompt.ts` | System/user prompt + tool definition |
| `src/offscreen/offscreen.html` / `offscreen.ts` | Extraction RPC endpoint |
| `src/offscreen/extract-core.ts` | Pure `DOMParser` + Readability extraction (testable) |
| `src/options/options.html` / `options.ts` | Settings UI |
| `build.mjs` | esbuild bundling + static copy |

---

### Task 1: Project scaffold and build pipeline

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `build.mjs`, `.gitignore`, `src/manifest.json`, stub entrypoints (`src/background/index.ts`, `src/content/index.ts`, `src/offscreen/offscreen.ts`, `src/offscreen/offscreen.html`, `src/options/options.ts`, `src/options/options.html`)

**Interfaces:**
- Produces: `npm run build` → loadable `dist/`; `npm test` → vitest runs.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "webcrawla",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mozilla/readability": "^0.5.0"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.268",
    "esbuild": "^0.21.0",
    "jsdom": "^24.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'jsdom' },
})
```

`build.mjs`:
```js
import * as esbuild from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })

await esbuild.build({
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    offscreen: 'src/offscreen/offscreen.ts',
    options: 'src/options/options.ts',
  },
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outdir: 'dist',
  logLevel: 'info',
})

cpSync('src/manifest.json', 'dist/manifest.json')
cpSync('src/offscreen/offscreen.html', 'dist/offscreen.html')
cpSync('src/options/options.html', 'dist/options.html')
```

`.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 2: Write manifest and stubs**

`src/manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "Webcrawla — AI Search Overviews",
  "version": "0.1.0",
  "description": "BYOK AI answer card for Startpage searches, grounded in a live crawl of the results.",
  "permissions": ["storage", "offscreen"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": [
        "https://*.startpage.com/sp/search*",
        "https://*.startpage.com/do/search*",
        "https://*.startpage.com/do/dsearch*"
      ],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "options_page": "options.html",
  "action": { "default_title": "Webcrawla" }
}
```

Stub `src/background/index.ts`: `console.log('webcrawla background')`
Stub `src/content/index.ts`: `console.log('webcrawla content')`
Stub `src/offscreen/offscreen.ts`: `export {}`
Stub `src/options/options.ts`: `export {}`

`src/offscreen/offscreen.html`:
```html
<!doctype html><html><head><meta charset="utf-8"></head><body><script src="offscreen.js"></script></body></html>
```

`src/options/options.html` (stub; real form in Task 13):
```html
<!doctype html><html><head><meta charset="utf-8"><title>Webcrawla Settings</title></head><body><script src="options.js"></script></body></html>
```

- [ ] **Step 3: Install and verify build**

Run: `npm install` then `npm run build`
Expected: `dist/` contains `background.js`, `content.js`, `offscreen.js`, `options.js`, `manifest.json`, `offscreen.html`, `options.html`. No errors.

- [ ] **Step 4: Verify typecheck and empty test run**

Run: `npm run typecheck` (passes) and `npm test` (expected: "no test files found" exit — acceptable; tests arrive in Task 2).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: scaffold MV3 extension with esbuild + vitest pipeline"
```

---

### Task 2: Shared types and settings module

**Files:**
- Create: `src/shared/types.ts`, `src/shared/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produces: all shared types below; `loadSettings(): Promise<Settings>`, `saveSettings(patch: Partial<Settings>): Promise<void>`, `DEFAULT_SETTINGS`.

- [ ] **Step 1: Write the failing test**

`tests/settings.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSettings, saveSettings } from '../src/shared/settings'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const store: Record<string, unknown> = {}

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => (store[key] === undefined ? {} : { [key]: store[key] }),
      set: async (obj: Record<string, unknown>) => { Object.assign(store, obj) },
    },
  },
})

beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

describe('settings', () => {
  it('returns defaults when nothing stored', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('merges stored values over defaults', async () => {
    store.settings = { apiKey: 'sk-test', model: 'glm-5.2' }
    const s = await loadSettings()
    expect(s.apiKey).toBe('sk-test')
    expect(s.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
  })

  it('saveSettings patches without clobbering', async () => {
    await saveSettings({ apiKey: 'sk-1' })
    await saveSettings({ model: 'other' })
    const s = await loadSettings()
    expect(s.apiKey).toBe('sk-1')
    expect(s.model).toBe('other')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL (cannot resolve `../src/shared/settings`)

- [ ] **Step 3: Write implementation**

`src/shared/types.ts`:
```ts
export type SerpResult = { title: string; url: string; snippet: string }

export type SourceInfo = { index: number; url: string; title: string; ok: boolean }

export type ExtractedSource = SourceInfo & { text: string }

export type StreamEvent =
  | { type: 'status'; message: string }
  | { type: 'sources'; sources: SourceInfo[] }
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type JobRequest = { type: 'run'; query: string; results: SerpResult[] }

export type Settings = {
  baseUrl: string
  apiKey: string
  model: string
  triggerMode: 'smart' | 'always' | 'manual'
  maxPrefetch: number
  pageCharBudget: number
  systemPromptOverride: string
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://ollama.com/v1',
  apiKey: '',
  model: 'glm-5.2',
  triggerMode: 'smart',
  maxPrefetch: 5,
  pageCharBudget: 8000,
  systemPromptOverride: '',
}
```

`src/shared/settings.ts`:
```ts
import { DEFAULT_SETTINGS, type Settings } from './types'

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings')
  return { ...DEFAULT_SETTINGS, ...((stored.settings as Partial<Settings>) ?? {}) }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await loadSettings()
  await chrome.storage.local.set({ settings: { ...current, ...patch } })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/settings.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/shared tests/settings.test.ts
git commit -m "feat: shared types and settings persistence"
```

---

### Task 3: Smart trigger heuristic

**Files:**
- Create: `src/content/trigger.ts`
- Test: `tests/trigger.test.ts`

**Interfaces:**
- Produces: `shouldAutoRun(query: string, mode: Settings['triggerMode']): boolean`

- [ ] **Step 1: Write the failing test**

`tests/trigger.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { shouldAutoRun } from '../src/content/trigger'

describe('shouldAutoRun', () => {
  it('always mode always runs', () => {
    expect(shouldAutoRun('gmail login', 'always')).toBe(true)
  })
  it('manual mode never runs', () => {
    expect(shouldAutoRun('how does mrna vaccine work', 'manual')).toBe(false)
  })
  it('smart: question-word queries run', () => {
    expect(shouldAutoRun('how does a heat pump work', 'smart')).toBe(true)
    expect(shouldAutoRun('why is the sky blue', 'smart')).toBe(true)
    expect(shouldAutoRun('what is the capital of mongolia', 'smart')).toBe(true)
  })
  it('smart: trailing question mark runs', () => {
    expect(shouldAutoRun('best budget mechanical keyboard 2026?', 'smart')).toBe(true)
  })
  it('smart: research phrasing runs', () => {
    expect(shouldAutoRun('rust vs go for web services', 'smart')).toBe(true)
    expect(shouldAutoRun('difference between tcp and udp', 'smart')).toBe(true)
  })
  it('smart: long queries run', () => {
    expect(shouldAutoRun('mechanical keyboard switch types linear tactile clicky comparison', 'smart')).toBe(true)
  })
  it('smart: navigational queries do not run', () => {
    expect(shouldAutoRun('gmail login', 'smart')).toBe(false)
    expect(shouldAutoRun('github.com', 'smart')).toBe(false)
    expect(shouldAutoRun('vivaldi browser download', 'smart')).toBe(false)
  })
  it('smart: short queries do not run', () => {
    expect(shouldAutoRun('weather', 'smart')).toBe(false)
    expect(shouldAutoRun('nba scores', 'smart')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trigger.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

`src/content/trigger.ts`:
```ts
import type { Settings } from '../shared/types'

const NAVIGATIONAL = /\b(login|log in|sign in|signup|sign up|download|official site|website)\b/
const DOMAIN_LIKE = /^[\w-]+\.(com|org|net|io|dev|app|gov|edu|co)(\/|$)/
const QUESTION_START = /^(how|what|why|when|where|who|which|can|does|do|is|are|should|will|could|would|explain)\b/
const RESEARCH_PHRASE = /\b(vs\.?|versus|difference between|best way to|how to|meaning of|compared to|comparison)\b/

export function shouldAutoRun(query: string, mode: Settings['triggerMode']): boolean {
  if (mode === 'always') return true
  if (mode === 'manual') return false
  const q = query.trim().toLowerCase()
  if (q.length < 8) return false
  if (DOMAIN_LIKE.test(q) || NAVIGATIONAL.test(q)) return false
  const words = q.split(/\s+/)
  if (words.length < 3) return false
  if (QUESTION_START.test(q) || q.endsWith('?')) return true
  if (RESEARCH_PHRASE.test(q)) return true
  return words.length >= 5
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/trigger.test.ts`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add src/content/trigger.ts tests/trigger.test.ts
git commit -m "feat: smart trigger heuristic for auto-run decisions"
```

---

### Task 4: SERP scraper with fallback

**Files:**
- Create: `src/content/serp-selectors.ts`
- Test: `tests/serp.test.ts`

**Interfaces:**
- Consumes: `SerpResult` from `src/shared/types.ts`
- Produces: `scrapeSerp(root: ParentNode): SerpResult[]` (deduped, external-only, max 10); `findResultsAnchor(doc: Document): Element | null` (element to insert the panel before)

- [ ] **Step 1: Write the failing test**

`tests/serp.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/serp.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

`src/content/serp-selectors.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/serp.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/content/serp-selectors.ts tests/serp.test.ts
git commit -m "feat: SERP scraper with selector candidates and generic fallback"
```

---

### Task 5: Sanitizing markdown renderer with citations

**Files:**
- Create: `src/content/markdown.ts`
- Test: `tests/markdown.test.ts`

**Interfaces:**
- Produces: `renderMarkdown(md: string, citationUrls: Map<number, string>): string` — returns sanitized HTML; `[n]` becomes `<sup class="cite"><a …>n</a></sup>` when `n` is in the map.

- [ ] **Step 1: Write the failing test**

`tests/markdown.test.ts`:
```ts
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/markdown.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

`src/content/markdown.ts`:
```ts
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(text: string, citations: Map<number, string>): string {
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener">${label}</a>`,
  )
  s = s.replace(/\[(\d{1,2})\]/g, (m, n: string) => {
    const url = citations.get(Number(n))
    if (!url) return m
    return `<sup class="cite"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${n}</a></sup>`
  })
  return s
}

function renderBlock(block: string, citations: Map<number, string>): string {
  const t = block.trim()
  if (!t) return ''
  if (t.startsWith('```')) {
    const code = t.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')
    return `<pre><code>${escapeHtml(code)}</code></pre>`
  }
  const heading = t.match(/^(#{1,4})\s+(.*)$/)
  if (heading && !t.includes('\n')) {
    const level = Math.min(heading[1].length + 2, 6)
    return `<h${level}>${inline(heading[2], citations)}</h${level}>`
  }
  const lines = t.split('\n')
  if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
    return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''), citations)}</li>`).join('')}</ul>`
  }
  if (lines.every(l => /^\s*\d+[.)]\s+/.test(l))) {
    return `<ol>${lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''), citations)}</li>`).join('')}</ol>`
  }
  return `<p>${inline(t, citations)}</p>`
}

export function renderMarkdown(md: string, citationUrls: Map<number, string>): string {
  return md
    .split(/\n{2,}/)
    .map(block => renderBlock(block, citationUrls))
    .join('')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/markdown.test.ts`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add src/content/markdown.ts tests/markdown.test.ts
git commit -m "feat: sanitizing markdown renderer with citation superscripts"
```

---

### Task 6: Prompt assembly

**Files:**
- Create: `src/background/prompt.ts`
- Test: `tests/prompt.test.ts`

**Interfaces:**
- Consumes: `ExtractedSource` from `src/shared/types.ts`
- Produces: `FETCH_PAGE_TOOL` (OpenAI tool definition), `buildSystemPrompt(override?: string): string`, `buildUserMessage(query: string, sources: ExtractedSource[]): string`, `formatSource(s: ExtractedSource): string`

- [ ] **Step 1: Write the failing test**

`tests/prompt.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { FETCH_PAGE_TOOL, buildSystemPrompt, buildUserMessage, formatSource } from '../src/background/prompt'
import type { ExtractedSource } from '../src/shared/types'

const src = (i: number, ok = true): ExtractedSource => ({
  index: i,
  url: `https://example.com/${i}`,
  title: `Title ${i}`,
  ok,
  text: ok ? `Content of page ${i}` : '',
})

describe('prompt assembly', () => {
  it('system prompt mentions citations and the tool', () => {
    const p = buildSystemPrompt()
    expect(p).toMatch(/\[n\]|\[1\]/)
    expect(p).toContain('fetch_page')
  })
  it('override replaces system prompt', () => {
    expect(buildSystemPrompt('be a pirate')).toBe('be a pirate')
  })
  it('formatSource numbers sources and includes content', () => {
    expect(formatSource(src(2))).toContain('[2] Title 2 — https://example.com/2')
    expect(formatSource(src(2))).toContain('Content of page 2')
  })
  it('failed sources are marked unavailable', () => {
    expect(formatSource(src(3, false))).toContain('(content unavailable)')
  })
  it('user message contains query and all sources', () => {
    const msg = buildUserMessage('how do heat pumps work', [src(1), src(2)])
    expect(msg).toContain('how do heat pumps work')
    expect(msg).toContain('[1] Title 1')
    expect(msg).toContain('[2] Title 2')
  })
  it('tool definition is a valid function tool named fetch_page', () => {
    expect(FETCH_PAGE_TOOL.type).toBe('function')
    expect(FETCH_PAGE_TOOL.function.name).toBe('fetch_page')
    expect(FETCH_PAGE_TOOL.function.parameters.required).toContain('url')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

`src/background/prompt.ts`:
```ts
import type { ExtractedSource } from '../shared/types'

export const FETCH_PAGE_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_page',
    description:
      'Fetch a web page and return its readable text content. Use when the provided sources are insufficient — e.g. to read another search result or follow a link mentioned in a source.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL of the page to fetch' },
      },
      required: ['url'],
    },
  },
} as const

const SYSTEM_PROMPT = `You are an AI search assistant that writes a grounded overview answering the user's search query, in the style of a search engine AI overview.

Rules:
- Base your answer ONLY on the numbered sources provided. Cite claims inline with bracketed source numbers like [1] or [2][3].
- Be concise: 120-250 words. Use markdown. Prefer a short direct answer first, then supporting detail. Use a bullet list only when it genuinely helps.
- If the sources do not contain enough information to answer, say so plainly rather than guessing.
- You may call the fetch_page tool to read additional pages (other search results, or links referenced in a source) when the provided content is insufficient. Do not call it when you already have enough.
- Never invent citations or URLs. Only cite source numbers that exist.`

export function buildSystemPrompt(override?: string): string {
  return override?.trim() ? override : SYSTEM_PROMPT
}

export function formatSource(s: ExtractedSource): string {
  const header = `[${s.index}] ${s.title} — ${s.url}`
  const body = s.ok && s.text ? s.text : '(content unavailable)'
  return `${header}\n${body}`
}

export function buildUserMessage(query: string, sources: ExtractedSource[]): string {
  const sourceBlock = sources.map(formatSource).join('\n\n')
  return `Search query: ${query}\n\nSources:\n\n${sourceBlock}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prompt.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/background/prompt.ts tests/prompt.test.ts
git commit -m "feat: prompt assembly and fetch_page tool definition"
```

---

### Task 7: OpenAI-compatible streaming LLM client

**Files:**
- Create: `src/background/llm.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
  type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
  type TurnResult = { content: string; toolCalls: ToolCall[]; finishReason: string | null }
  streamChat(opts: { baseUrl: string; apiKey: string; model: string; messages: ChatMessage[]; tools?: unknown[]; signal?: AbortSignal; onToken?: (t: string) => void }): Promise<TurnResult>
  ```

- [ ] **Step 1: Write the failing test**

`tests/llm.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamChat } from '../src/background/llm'

function sseResponse(events: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const e of events) controller.enqueue(enc.encode(e))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

afterEach(() => vi.unstubAllGlobals())

describe('streamChat', () => {
  it('streams content tokens and returns full content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      chunk({ choices: [{ delta: { content: 'Hel' } }] }),
      chunk({ choices: [{ delta: { content: 'lo' } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ])))
    const tokens: string[] = []
    const r = await streamChat({
      baseUrl: 'https://ollama.com/v1', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      onToken: t => tokens.push(t),
    })
    expect(tokens).toEqual(['Hel', 'lo'])
    expect(r.content).toBe('Hello')
    expect(r.finishReason).toBe('stop')
    expect(r.toolCalls).toEqual([])
  })

  it('accumulates tool call deltas across chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'fetch_page', arguments: '{"ur' } }] } }] }),
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'l":"https://x.com"}' } }] } }] }),
      chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])))
    const r = await streamChat({
      baseUrl: 'https://ollama.com/v1', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].id).toBe('c1')
    expect(r.toolCalls[0].function.name).toBe('fetch_page')
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ url: 'https://x.com' })
    expect(r.finishReason).toBe('tool_calls')
  })

  it('sends auth header and hits chat/completions', async () => {
    const spy = vi.fn(async () => sseResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', spy)
    await streamChat({ baseUrl: 'https://ollama.com/v1/', apiKey: 'sk-abc', model: 'glm-5.2', messages: [] })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://ollama.com/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-abc')
    const body = JSON.parse(init.body as string)
    expect(body.stream).toBe(true)
    expect(body.model).toBe('glm-5.2')
  })

  it('throws readable error on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid api key', { status: 401 })))
    await expect(
      streamChat({ baseUrl: 'https://ollama.com/v1', apiKey: 'bad', model: 'm', messages: [] }),
    ).rejects.toThrow(/401.*invalid api key/s)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

`src/background/llm.ts`:
```ts
export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export type TurnResult = { content: string; toolCalls: ToolCall[]; finishReason: string | null }

export async function streamChat(opts: {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: unknown[]
  signal?: AbortSignal
  onToken?: (t: string) => void
}): Promise<TurnResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      stream: true,
    }),
    signal: opts.signal,
  })
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`LLM request failed (${res.status}): ${detail}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason: string | null = null
  const toolCalls: ToolCall[] = []

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const choice = parsed.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
      opts.onToken?.(delta.content)
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0
      if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (tc.id) toolCalls[i].id = tc.id
      if (tc.function?.name) toolCalls[i].function.name += tc.function.name
      if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  }
  handleLine(buffer)

  return { content, toolCalls: toolCalls.filter(Boolean), finishReason }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/background/llm.ts tests/llm.test.ts
git commit -m "feat: streaming OpenAI-compatible client with tool-call accumulation"
```

---

### Task 8: Page fetcher

**Files:**
- Create: `src/background/fetcher.ts`
- Test: `tests/fetcher.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type FetchPageResult = { ok: true; html: string } | { ok: false; error: string }
  fetchPage(url: string, opts?: { timeoutMs?: number; maxChars?: number }): Promise<FetchPageResult>
  ```

- [ ] **Step 1: Write the failing test**

`tests/fetcher.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fetcher.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

`src/background/fetcher.ts`:
```ts
export type FetchPageResult = { ok: true; html: string } | { ok: false; error: string }

export async function fetchPage(
  url: string,
  opts: { timeoutMs?: number; maxChars?: number } = {},
): Promise<FetchPageResult> {
  const { timeoutMs = 4000, maxChars = 1_500_000 } = opts
  if (!/^https?:\/\//.test(url)) return { ok: false, error: 'not an http(s) url' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      credentials: 'omit',
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const type = res.headers.get('content-type') ?? ''
    if (type && !type.includes('html')) return { ok: false, error: `unsupported content-type: ${type}` }
    const html = (await res.text()).slice(0, maxChars)
    return { ok: true, html }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fetcher.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/background/fetcher.ts tests/fetcher.test.ts
git commit -m "feat: page fetcher with timeout, type and size guards"
```

---

### Task 9: Readability extraction (offscreen document)

**Files:**
- Create: `src/offscreen/extract-core.ts`, `src/offscreen/offscreen.ts` (replace stub), `src/background/extract.ts`
- Test: `tests/extract.test.ts`

**Interfaces:**
- Produces: `extractReadable(html: string, url: string, charBudget: number): { title: string; text: string }` (pure, offscreen-side); `extractInOffscreen(html: string, url: string, charBudget: number): Promise<{ title: string; text: string }>` (background-side RPC, throws on failure).
- RPC message shape: `{ target: 'offscreen', kind: 'extract', html, url, charBudget }` → `{ ok: true, title, text } | { ok: false, error }`.

- [ ] **Step 1: Write the failing test**

`tests/extract.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extract.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

`src/offscreen/extract-core.ts`:
```ts
import { Readability } from '@mozilla/readability'

export function extractReadable(
  html: string,
  url: string,
  charBudget: number,
): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const base = doc.createElement('base')
  base.href = url
  doc.head.appendChild(base)
  let article: { title?: string | null; textContent?: string | null } | null = null
  try {
    article = new Readability(doc, { charThreshold: 250 }).parse()
  } catch {
    article = null
  }
  const title = (article?.title || doc.title || url).trim()
  let text = (article?.textContent || doc.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > charBudget) text = text.slice(0, charBudget) + '…'
  return { title, text }
}
```

`src/offscreen/offscreen.ts`:
```ts
import { extractReadable } from './extract-core'

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.kind !== 'extract') return
  try {
    sendResponse({ ok: true, ...extractReadable(msg.html, msg.url, msg.charBudget) })
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
```

`src/background/extract.ts`:
```ts
let creating: Promise<void> | null = null

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: 'Extract readable text from fetched result pages',
      })
      .finally(() => { creating = null })
  }
  await creating
}

export async function extractInOffscreen(
  html: string,
  url: string,
  charBudget: number,
): Promise<{ title: string; text: string }> {
  await ensureOffscreen()
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', kind: 'extract', html, url, charBudget })
  if (!res?.ok) throw new Error(res?.error ?? 'extraction failed')
  return { title: res.title, text: res.text }
}
```

- [ ] **Step 4: Run tests and build**

Run: `npx vitest run tests/extract.test.ts` — Expected: 3 passed
Run: `npm run build` — Expected: success (Readability bundles into `offscreen.js`)

- [ ] **Step 5: Commit**

```bash
git add src/offscreen src/background/extract.ts tests/extract.test.ts
git commit -m "feat: Readability extraction via offscreen document RPC"
```

---

### Task 10: Agent orchestrator (hybrid race + tool loop)

**Files:**
- Create: `src/background/agent.ts`
- Test: `tests/agent.test.ts`

**Interfaces:**
- Consumes: `streamChat`/`ChatMessage`/`ToolCall` (Task 7), `buildSystemPrompt`/`buildUserMessage`/`FETCH_PAGE_TOOL` (Task 6), shared types (Task 2).
- Produces:
  ```ts
  type Emit = (e: StreamEvent) => void
  type AgentDeps = {
    fetchAndExtract: (url: string, charBudget: number) => Promise<{ title: string; text: string } | null>
    streamChat: typeof streamChat
  }
  runAgent(query: string, results: SerpResult[], settings: Settings, deps: AgentDeps, emit: Emit): Promise<void>
  ```
- Behavior contract: prefetches `settings.maxPrefetch` pages in parallel → emits `sources` → streams turns with `FETCH_PAGE_TOOL` → executes tool calls (max 3 tool rounds, 8 pages total, 45s budget) → emits `done`; any thrown error becomes an `error` event. Falls back to snippets when zero pages extract.

- [ ] **Step 1: Write the failing test**

`tests/agent.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { runAgent, type AgentDeps } from '../src/background/agent'
import { DEFAULT_SETTINGS, type SerpResult, type StreamEvent } from '../src/shared/types'
import type { streamChat, TurnResult } from '../src/background/llm'

const settings = { ...DEFAULT_SETTINGS, apiKey: 'k', maxPrefetch: 2 }
const results: SerpResult[] = [
  { title: 'A', url: 'https://a.com', snippet: 'snip a' },
  { title: 'B', url: 'https://b.com', snippet: 'snip b' },
  { title: 'C', url: 'https://c.com', snippet: 'snip c' },
]

function collect() {
  const events: StreamEvent[] = []
  return { events, emit: (e: StreamEvent) => events.push(e) }
}

const okExtract = async (url: string) => ({ title: `T:${url}`, text: `long content of ${url} `.repeat(20) })

function chatReturning(...turns: TurnResult[]): typeof streamChat {
  let i = 0
  return vi.fn(async (opts: Parameters<typeof streamChat>[0]) => {
    const turn = turns[Math.min(i, turns.length - 1)]
    i++
    if (turn.content) for (const ch of turn.content) opts.onToken?.(ch)
    return turn
  }) as unknown as typeof streamChat
}

describe('runAgent', () => {
  it('prefetches, emits sources, streams tokens, emits done', async () => {
    const { events, emit } = collect()
    const deps: AgentDeps = {
      fetchAndExtract: vi.fn(okExtract),
      streamChat: chatReturning({ content: 'Answer [1].', toolCalls: [], finishReason: 'stop' }),
    }
    await runAgent('how do heat pumps work', results, settings, deps, emit)
    expect(deps.fetchAndExtract).toHaveBeenCalledTimes(2) // maxPrefetch
    const sources = events.find(e => e.type === 'sources')
    expect(sources && sources.type === 'sources' && sources.sources).toHaveLength(2)
    expect(events.filter(e => e.type === 'token').map(e => (e as any).text).join('')).toBe('Answer [1].')
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('executes tool calls and feeds results back', async () => {
    const { events, emit } = collect()
    const chat = chatReturning(
      {
        content: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://c.com"}' } }],
        finishReason: 'tool_calls',
      },
      { content: 'Deeper answer [3].', toolCalls: [], finishReason: 'stop' },
    )
    const deps: AgentDeps = { fetchAndExtract: vi.fn(okExtract), streamChat: chat }
    await runAgent('q about things', results, settings, deps, emit)
    expect(deps.fetchAndExtract).toHaveBeenCalledWith('https://c.com', settings.pageCharBudget)
    expect(chat).toHaveBeenCalledTimes(2)
    const calls = (chat as any).mock.calls
    const secondMessages = calls[1][0].messages
    expect(secondMessages.some((m: any) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(true)
    // updated sources event includes the newly fetched page
    const sourceEvents = events.filter(e => e.type === 'sources')
    expect((sourceEvents.at(-1) as any).sources).toHaveLength(3)
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('stops tool loop after 3 rounds', async () => {
    const { emit } = collect()
    const toolTurn: TurnResult = {
      content: '',
      toolCalls: [{ id: 'x', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://c.com"}' } }],
      finishReason: 'tool_calls',
    }
    const chat = chatReturning(toolTurn, toolTurn, toolTurn, toolTurn, toolTurn)
    await runAgent('q', results, settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat }, emit)
    expect(chat).toHaveBeenCalledTimes(4) // initial + 3 tool rounds
  })

  it('falls back to snippets when nothing extracts', async () => {
    const { emit } = collect()
    const chat = chatReturning({ content: 'ok', toolCalls: [], finishReason: 'stop' })
    await runAgent('q', results, settings, { fetchAndExtract: vi.fn(async () => null), streamChat: chat }, emit)
    const messages = (chat as any).mock.calls[0][0].messages
    expect(messages[1].content).toContain('snip a')
  })

  it('emits error event when the LLM call throws', async () => {
    const { events, emit } = collect()
    const chat = vi.fn(async () => { throw new Error('boom 401') }) as unknown as typeof streamChat
    await runAgent('q', results, settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat }, emit)
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('boom 401') })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

`src/background/agent.ts`:
```ts
import type { ExtractedSource, SerpResult, Settings, StreamEvent } from '../shared/types'
import type { ChatMessage, streamChat as streamChatFn } from './llm'
import { FETCH_PAGE_TOOL, buildSystemPrompt, buildUserMessage } from './prompt'

export type Emit = (e: StreamEvent) => void

export type AgentDeps = {
  fetchAndExtract: (url: string, charBudget: number) => Promise<{ title: string; text: string } | null>
  streamChat: typeof streamChatFn
}

const MAX_TOOL_ROUNDS = 3
const MAX_TOTAL_PAGES = 8
const OVERALL_BUDGET_MS = 45_000
const MIN_USEFUL_CHARS = 200

function toInfo(sources: ExtractedSource[]) {
  return sources.map(({ text: _text, ...info }) => info)
}

function parseUrlArg(raw: string): string | null {
  try {
    const url = JSON.parse(raw)?.url
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null
  } catch {
    return null
  }
}

export async function runAgent(
  query: string,
  results: SerpResult[],
  settings: Settings,
  deps: AgentDeps,
  emit: Emit,
): Promise<void> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), OVERALL_BUDGET_MS)
  try {
    emit({ type: 'status', message: 'Reading sources…' })
    const top = results.slice(0, settings.maxPrefetch)
    const sources: ExtractedSource[] = await Promise.all(
      top.map(async (r, i) => {
        const ex = await deps.fetchAndExtract(r.url, settings.pageCharBudget)
        const ok = !!ex && ex.text.length >= MIN_USEFUL_CHARS
        return {
          index: i + 1,
          url: r.url,
          title: ex?.title || r.title,
          ok,
          text: ok ? ex!.text : '',
        }
      }),
    )

    if (!sources.some(s => s.ok)) {
      // snippet-only fallback, labeled via status so the panel can note it
      top.forEach((r, i) => {
        sources[i] = { ...sources[i], text: r.snippet, ok: r.snippet.length > 0 }
      })
      emit({ type: 'status', message: 'Pages unavailable — summarizing search snippets only' })
    }
    emit({ type: 'sources', sources: toInfo(sources) })

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(settings.systemPromptOverride || undefined) },
      { role: 'user', content: buildUserMessage(query, sources) },
    ]

    let pagesFetched = sources.length
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const turn = await deps.streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages,
        tools: [FETCH_PAGE_TOOL],
        signal: abort.signal,
        onToken: t => emit({ type: 'token', text: t }),
      })
      if (!turn.toolCalls.length || round === MAX_TOOL_ROUNDS) break

      messages.push({ role: 'assistant', content: turn.content || null, tool_calls: turn.toolCalls })
      for (const call of turn.toolCalls) {
        let resultText = 'Error: total page limit reached; answer with what you have.'
        if (pagesFetched < MAX_TOTAL_PAGES) {
          const url = parseUrlArg(call.function.arguments)
          const ex = url ? await deps.fetchAndExtract(url, settings.pageCharBudget) : null
          if (ex && url) {
            pagesFetched++
            const index = sources.length + 1
            sources.push({ index, url, title: ex.title, ok: true, text: ex.text })
            emit({ type: 'sources', sources: toInfo(sources) })
            resultText = `[${index}] ${ex.title} — ${url}\n${ex.text}`
          } else {
            resultText = 'Error: could not fetch or extract that page.'
          }
        }
        messages.push({ role: 'tool', content: resultText, tool_call_id: call.id })
      }
    }
    emit({ type: 'done' })
  } catch (err) {
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent.test.ts`
Expected: 5 passed. Also run full suite: `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/background/agent.ts tests/agent.test.ts
git commit -m "feat: hybrid-race agent orchestrator with capped tool loop"
```

---

### Task 11: Background service worker wiring

**Files:**
- Modify: `src/background/index.ts` (replace stub)

**Interfaces:**
- Consumes: everything from Tasks 2, 7, 8, 9, 10.
- Produces: port protocol — content connects with `chrome.runtime.connect({ name: 'webcrawla' })`, posts a `JobRequest`, receives `StreamEvent`s.

- [ ] **Step 1: Write implementation**

`src/background/index.ts`:
```ts
import type { JobRequest, StreamEvent } from '../shared/types'
import { loadSettings } from '../shared/settings'
import { runAgent, type AgentDeps } from './agent'
import { extractInOffscreen } from './extract'
import { fetchPage } from './fetcher'
import { streamChat } from './llm'

const deps: AgentDeps = {
  fetchAndExtract: async (url, charBudget) => {
    const r = await fetchPage(url)
    if (!r.ok) return null
    try {
      return await extractInOffscreen(r.html, url, charBudget)
    } catch {
      return null
    }
  },
  streamChat,
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'webcrawla') return
  let disconnected = false
  port.onDisconnect.addListener(() => { disconnected = true })
  const emit = (e: StreamEvent) => {
    if (disconnected) return
    try {
      port.postMessage(e)
    } catch {
      disconnected = true
    }
  }
  port.onMessage.addListener(async (msg: JobRequest) => {
    if (msg?.type !== 'run') return
    const settings = await loadSettings()
    if (!settings.apiKey || !settings.model) {
      emit({ type: 'error', message: 'Not configured — set your endpoint, API key and model in Webcrawla options.' })
      return
    }
    await runAgent(msg.query, msg.results, settings, deps, emit)
  })
})
```

- [ ] **Step 2: Verify build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add src/background/index.ts
git commit -m "feat: background worker port protocol and job runner"
```

---

### Task 12: Answer panel and content script wiring

**Files:**
- Create: `src/content/panel.ts`
- Modify: `src/content/index.ts` (replace stub)

**Interfaces:**
- Consumes: `renderMarkdown` (Task 5), `scrapeSerp`/`findResultsAnchor` (Task 4), `shouldAutoRun` (Task 3), `loadSettings` (Task 2), port protocol (Task 11).
- Produces:
  ```ts
  type Panel = {
    setSetup(): void
    setIdle(onRun: () => void): void
    setLoading(message: string): void
    setSources(sources: SourceInfo[]): void
    appendToken(text: string): void
    finish(): void
    setError(message: string, onRetry: () => void): void
  }
  createPanel(host: HTMLElement, meta: { model: string; endpointHost: string }): Panel
  ```

- [ ] **Step 1: Write the panel**

`src/content/panel.ts`:
```ts
import type { SourceInfo } from '../shared/types'
import { renderMarkdown } from './markdown'

export type Panel = {
  setSetup(): void
  setIdle(onRun: () => void): void
  setLoading(message: string): void
  setSources(sources: SourceInfo[]): void
  appendToken(text: string): void
  finish(): void
  setError(message: string, onRetry: () => void): void
}

const CSS = `
:host { all: initial; display: block; }
.card { font: 14px/1.55 system-ui, -apple-system, sans-serif; color: #1a1a1a; background: #fff;
  border: 1px solid #dcdfe4; border-radius: 12px; padding: 14px 16px; margin: 0 0 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06); }
@media (prefers-color-scheme: dark) {
  .card { background: #1e2128; color: #e6e6e6; border-color: #3a3f4a; }
  .card a { color: #8ab4f8; }
}
.card a { color: #3367d6; }
.head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.head .grow { flex: 1; }
.body p { margin: 0 0 8px; }
.body ul, .body ol { margin: 0 0 8px 18px; padding: 0; }
.body h3, .body h4, .body h5, .body h6 { margin: 10px 0 6px; font-size: 14px; }
.body code { background: rgba(127,127,127,.15); border-radius: 4px; padding: 1px 4px; font-size: 12px; font-family: monospace; }
.body pre { background: rgba(127,127,127,.12); border-radius: 8px; padding: 10px; overflow-x: auto; }
.body pre code { background: none; padding: 0; }
sup.cite a { text-decoration: none; font-weight: 600; padding: 0 1px; }
.sources { display: flex; gap: 6px; align-items: center; margin-top: 10px; flex-wrap: wrap; font-size: 12px; opacity: .85; }
.sources img { width: 16px; height: 16px; border-radius: 4px; vertical-align: middle; }
.foot { margin-top: 10px; font-size: 11px; opacity: .6; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
button.wc { cursor: pointer; border: 1px solid #c9cdd4; background: transparent; color: inherit;
  border-radius: 8px; padding: 5px 12px; font: inherit; font-size: 12px; }
button.wc:hover { background: rgba(127,127,127,.1); }
.shimmer { animation: wc-pulse 1.2s ease-in-out infinite; }
@keyframes wc-pulse { 0%, 100% { opacity: .75; } 50% { opacity: .3; } }
.err { color: #d93025; }
`

function faviconUrl(pageUrl: string): string {
  try {
    return `https://icons.duckduckgo.com/ip3/${new URL(pageUrl).hostname}.ico`
  } catch {
    return ''
  }
}

export function createPanel(host: HTMLElement, meta: { model: string; endpointHost: string }): Panel {
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS
  const card = document.createElement('div')
  card.className = 'card'
  card.innerHTML = `
    <div class="head"><span>✨ AI Overview</span><span class="grow"></span>
      <button class="wc toggle" title="Collapse">–</button></div>
    <div class="content">
      <div class="body"></div>
      <div class="sources"></div>
      <div class="foot">
        <span class="meta"></span>
        <span class="actions"></span>
      </div>
    </div>`
  root.append(style, card)

  const body = card.querySelector('.body') as HTMLElement
  const sourcesEl = card.querySelector('.sources') as HTMLElement
  const metaEl = card.querySelector('.meta') as HTMLElement
  const actionsEl = card.querySelector('.actions') as HTMLElement
  const content = card.querySelector('.content') as HTMLElement
  const toggle = card.querySelector('.toggle') as HTMLButtonElement
  toggle.addEventListener('click', () => {
    const hidden = content.style.display === 'none'
    content.style.display = hidden ? '' : 'none'
    toggle.textContent = hidden ? '–' : '+'
  })
  metaEl.textContent = `generated by ${meta.model} via ${meta.endpointHost}`

  let markdown = ''
  let citations = new Map<number, string>()
  let renderQueued = false

  const render = () => {
    renderQueued = false
    body.innerHTML = renderMarkdown(markdown, citations)
  }
  const scheduleRender = () => {
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(render)
  }
  const button = (label: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.className = 'wc'
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  return {
    setSetup() {
      body.innerHTML = '<p><strong>Webcrawla isn’t configured yet.</strong> Add your endpoint, API key and model to get AI overviews here.</p>'
      actionsEl.replaceChildren(button('Open settings', () => {
        chrome.runtime.sendMessage({ target: 'background', kind: 'open-options' })
      }))
    },
    setIdle(onRun) {
      body.innerHTML = ''
      actionsEl.replaceChildren()
      body.replaceChildren(button('✨ Summarize these results', onRun))
    },
    setLoading(message) {
      const p = document.createElement('p')
      p.className = 'shimmer'
      p.textContent = message
      if (!markdown) body.replaceChildren(p)
      actionsEl.replaceChildren()
    },
    setSources(sources) {
      citations = new Map(sources.map(s => [s.index, s.url]))
      sourcesEl.replaceChildren(
        ...sources.filter(s => s.ok).map(s => {
          const a = document.createElement('a')
          a.href = s.url
          a.target = '_blank'
          a.rel = 'noopener'
          a.title = s.title
          const img = document.createElement('img')
          img.src = faviconUrl(s.url)
          img.alt = ''
          a.append(img)
          return a
        }),
      )
      const failed = sources.filter(s => !s.ok).length
      if (failed) {
        const note = document.createElement('span')
        note.textContent = `(${failed} source${failed > 1 ? 's' : ''} unavailable)`
        sourcesEl.append(note)
      }
    },
    appendToken(text) {
      if (!markdown) body.replaceChildren() // clear shimmer on first token
      markdown += text
      scheduleRender()
    },
    finish() {
      render()
      actionsEl.replaceChildren()
    },
    setError(message, onRetry) {
      const p = document.createElement('p')
      p.className = 'err'
      p.textContent = message
      body.replaceChildren(p)
      actionsEl.replaceChildren(button('Retry', onRetry))
    },
  }
}
```

- [ ] **Step 2: Write the content entrypoint**

`src/content/index.ts`:
```ts
import type { StreamEvent } from '../shared/types'
import { loadSettings } from '../shared/settings'
import { findResultsAnchor, scrapeSerp } from './serp-selectors'
import { shouldAutoRun } from './trigger'
import { createPanel, type Panel } from './panel'

function getQuery(): string {
  const input = document.querySelector<HTMLInputElement>('input[name="query"], input#q')
  const fromInput = input?.value?.trim()
  if (fromInput) return fromInput
  const params = new URLSearchParams(location.search)
  return (params.get('query') ?? params.get('q') ?? '').trim()
}

function startJob(query: string, results: ReturnType<typeof scrapeSerp>, panel: Panel) {
  panel.setLoading('Reading sources…')
  const port = chrome.runtime.connect({ name: 'webcrawla' })
  port.postMessage({ type: 'run', query, results })
  port.onMessage.addListener((e: StreamEvent) => {
    switch (e.type) {
      case 'status': panel.setLoading(e.message); break
      case 'sources': panel.setSources(e.sources); break
      case 'token': panel.appendToken(e.text); break
      case 'done': panel.finish(); port.disconnect(); break
      case 'error': panel.setError(e.message, () => startJob(query, results, panel)); port.disconnect(); break
    }
  })
}

async function init() {
  const query = getQuery()
  if (!query) return
  const results = scrapeSerp(document)
  const anchor = findResultsAnchor(document)
  if (!anchor?.parentElement) return

  const settings = await loadSettings()
  document.getElementById('webcrawla-panel')?.remove()
  const host = document.createElement('div')
  host.id = 'webcrawla-panel'
  anchor.parentElement.insertBefore(host, anchor)

  let endpointHost = settings.baseUrl
  try { endpointHost = new URL(settings.baseUrl).host } catch { /* show raw value */ }
  const panel = createPanel(host, { model: settings.model, endpointHost })

  if (!settings.apiKey || !settings.model) {
    panel.setSetup()
    return
  }
  const run = () => startJob(query, results, panel)
  if (results.length && shouldAutoRun(query, settings.triggerMode)) run()
  else panel.setIdle(run)
}

// Startpage sometimes swaps results without a full reload; watch the URL.
let lastHref = location.href
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href
    void init()
  }
}, 1000)

void init()
```

- [ ] **Step 3: Add options-opening handler to background**

Append to `src/background/index.ts`:
```ts
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.target === 'background' && msg.kind === 'open-options') {
    void chrome.runtime.openOptionsPage()
  }
})
```

- [ ] **Step 4: Verify build, typecheck, full test suite**

Run: `npm run build && npm run typecheck && npm test`
Expected: all succeed.

- [ ] **Step 5: Commit**

```bash
git add src/content src/background/index.ts
git commit -m "feat: shadow-DOM answer panel and content script wiring"
```

---

### Task 13: Options page

**Files:**
- Modify: `src/options/options.html`, `src/options/options.ts` (replace stubs)

**Interfaces:**
- Consumes: `loadSettings`/`saveSettings` (Task 2).

- [ ] **Step 1: Write the options page**

`src/options/options.html`:
```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Webcrawla Settings</title>
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; max-width: 560px; margin: 32px auto; padding: 0 16px; color: #1a1a1a; }
    @media (prefers-color-scheme: dark) { body { background: #1e2128; color: #e6e6e6; } input, select, textarea { background: #2a2e37; color: #e6e6e6; border-color: #3a3f4a; } }
    h1 { font-size: 18px; }
    label { display: block; margin: 14px 0 4px; font-weight: 600; font-size: 13px; }
    input, select, textarea { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #c9cdd4; border-radius: 8px; font: inherit; }
    .hint { font-size: 12px; opacity: .65; margin-top: 3px; }
    .row { display: flex; gap: 12px; } .row > div { flex: 1; }
    button { margin-top: 18px; padding: 8px 18px; border-radius: 8px; border: 1px solid #c9cdd4; background: #3367d6; color: #fff; font: inherit; cursor: pointer; }
    #status { margin-left: 10px; font-size: 13px; color: #188038; }
  </style>
</head>
<body>
  <h1>✨ Webcrawla Settings</h1>
  <label for="baseUrl">OpenAI-compatible endpoint base URL</label>
  <input id="baseUrl" placeholder="https://ollama.com/v1">
  <div class="hint">Must expose POST /chat/completions. Ollama Cloud: https://ollama.com/v1</div>

  <label for="apiKey">API key</label>
  <input id="apiKey" type="password" autocomplete="off">
  <div class="hint">Stored only on this device (chrome.storage.local); sent only to the endpoint above.</div>

  <label for="model">Model name</label>
  <input id="model" placeholder="glm-5.2">

  <label for="triggerMode">Trigger</label>
  <select id="triggerMode">
    <option value="smart">Smart — auto-run on question-like searches</option>
    <option value="always">Always — every search</option>
    <option value="manual">Manual — only when I click Summarize</option>
  </select>

  <div class="row">
    <div>
      <label for="maxPrefetch">Pages to prefetch</label>
      <input id="maxPrefetch" type="number" min="1" max="8">
    </div>
    <div>
      <label for="pageCharBudget">Chars per page</label>
      <input id="pageCharBudget" type="number" min="1000" max="30000" step="1000">
    </div>
  </div>

  <label for="systemPromptOverride">System prompt override (optional)</label>
  <textarea id="systemPromptOverride" rows="4" placeholder="Leave empty for the built-in prompt"></textarea>

  <button id="save">Save</button><span id="status"></span>
  <script src="options.js"></script>
</body>
</html>
```

`src/options/options.ts`:
```ts
import { loadSettings, saveSettings } from '../shared/settings'
import type { Settings } from '../shared/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

async function restore() {
  const s = await loadSettings()
  $<HTMLInputElement>('baseUrl').value = s.baseUrl
  $<HTMLInputElement>('apiKey').value = s.apiKey
  $<HTMLInputElement>('model').value = s.model
  $<HTMLSelectElement>('triggerMode').value = s.triggerMode
  $<HTMLInputElement>('maxPrefetch').value = String(s.maxPrefetch)
  $<HTMLInputElement>('pageCharBudget').value = String(s.pageCharBudget)
  $<HTMLTextAreaElement>('systemPromptOverride').value = s.systemPromptOverride
}

async function save() {
  const patch: Partial<Settings> = {
    baseUrl: $<HTMLInputElement>('baseUrl').value.trim(),
    apiKey: $<HTMLInputElement>('apiKey').value.trim(),
    model: $<HTMLInputElement>('model').value.trim(),
    triggerMode: $<HTMLSelectElement>('triggerMode').value as Settings['triggerMode'],
    maxPrefetch: Math.min(8, Math.max(1, Number($<HTMLInputElement>('maxPrefetch').value) || 5)),
    pageCharBudget: Math.min(30000, Math.max(1000, Number($<HTMLInputElement>('pageCharBudget').value) || 8000)),
    systemPromptOverride: $<HTMLTextAreaElement>('systemPromptOverride').value.trim(),
  }
  await saveSettings(patch)
  const status = $<HTMLSpanElement>('status')
  status.textContent = 'Saved ✓'
  setTimeout(() => { status.textContent = '' }, 2000)
}

document.addEventListener('DOMContentLoaded', () => {
  void restore()
  $<HTMLButtonElement>('save').addEventListener('click', () => void save())
})
```

- [ ] **Step 2: Verify build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/options
git commit -m "feat: options page for BYOK endpoint, key, model and behavior"
```

---

### Task 14: End-to-end verification in Vivaldi

**Files:**
- Possibly modify: `src/content/serp-selectors.ts` (selector reality check), `README.md` (create)

This task is manual verification with the user in the loop — the live Startpage DOM and the user's Ollama Cloud key are required.

- [ ] **Step 1: Build and load**

Run: `npm run build`. Then in Vivaldi: `vivaldi://extensions` → enable Developer Mode → "Load unpacked" → select the `dist/` folder.

- [ ] **Step 2: Configure**

Open extension options → enter Ollama Cloud endpoint (`https://ollama.com/v1`), API key, model name → Save.

- [ ] **Step 3: Selector reality check**

Search something on Startpage (e.g. "how do heat pumps work"). If the panel doesn't appear or shows no sources: open DevTools on the results page, inspect the real result markup, update `RESULT_CONTAINER_SELECTORS` / `SNIPPET_SELECTORS` in `src/content/serp-selectors.ts` to match, update the `KNOWN_MARKUP` fixture in `tests/serp.test.ts` to mirror the real structure, re-run `npm test`, rebuild, reload the extension.

- [ ] **Step 4: Verify each behavior**

- Question query ("why is the sky blue") → auto-runs, shimmer → streamed answer with citations and favicons.
- Navigational query ("gmail login") → collapsed card with Summarize button only.
- Click a citation superscript → opens the source.
- Break the API key → readable error + working Retry.
- Background worker logs: `vivaldi://extensions` → Webcrawla → "service worker" link opens its console.

- [ ] **Step 5: Write README and commit**

Create `README.md` with: what it is, build instructions (`npm install && npm run build`), load-unpacked instructions, options setup, the selector-maintenance note pointing at `src/content/serp-selectors.ts`.

```bash
git add -A
git commit -m "docs: README with setup and selector maintenance notes"
```

---

## Self-Review Notes

- **Spec coverage:** trigger heuristic (T3), SERP scrape + fallback + anchor (T4), shadow-DOM panel with citations/favicons/collapse/footer/retry (T12), hybrid race + fetch_page tool + caps (T10), offscreen Readability (T9), streaming SSE client (T7), settings/storage.local (T2), options UI (T13), setup card (T12), snippet fallback (T10), 45s budget (T10), manifest/permissions (T1), E2E + selector drift plan (T14). Follow-up chat, other engines, web_search tool: out of scope per spec.
- **Type consistency:** `SerpResult`/`SourceInfo`/`ExtractedSource`/`StreamEvent`/`Settings` defined once in `src/shared/types.ts` and imported everywhere; `ChatMessage`/`ToolCall`/`TurnResult` live in `llm.ts`; agent consumes `streamChat` via `AgentDeps` so tests inject fakes.
- **Known judgment call:** `runAgent`'s 45s budget aborts the in-flight LLM stream via `AbortSignal`; between-round work is bounded by per-fetch timeouts, which is sufficient in practice.
