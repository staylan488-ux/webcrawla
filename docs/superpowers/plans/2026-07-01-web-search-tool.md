# web_search Tool (v2.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a `web_search(query)` tool — DuckDuckGo HTML backend by default, optional BYOK Perplexity Search API — so summaries and follow-ups can discover pages beyond the original Startpage result set.

**Architecture:** A provider-routing `searchWeb(query, settings)` in a new `src/background/search.ts` (DDG HTML fetched via the existing fetcher and parsed in the offscreen document; Perplexity via `POST api.perplexity.ai/search`). A `WEB_SEARCH_TOOL` joins `FETCH_PAGE_TOOL` in the shared exchange loop with a 2-searches-per-exchange cap; results are returned to the model as candidate lists (not sources — only fetched pages get citation numbers). Settings/options gain the provider choice and Perplexity key. Spec: `docs/superpowers/specs/2026-07-01-web-search-tool-design.md`.

**Tech Stack:** unchanged — TypeScript strict, esbuild, vitest + jsdom, no new dependencies.

## Global Constraints

- Caps: **max 2 web_search calls per exchange**, **max 5 results per search**, **6 s provider timeout**; existing exchange caps (8 pages / 3 rounds / 45 s) unchanged. Searches go through the exchange's budget race.
- Exact tool-message strings: `Error: invalid search query.` / `Error: search limit reached; work with what you have.` / `No results found.` / `Error: search failed.`
- `settings.searchProvider: 'ddg' | 'perplexity'` (default `'ddg'`); `settings.perplexityApiKey: ''`. Perplexity selected with an empty key → silent DDG fallback at runtime.
- The Perplexity key is sent ONLY to `https://api.perplexity.ai`; DDG queries go only to `https://html.duckduckgo.com`.
- Search results are candidates, never sources: citation numbering and the sources strip change only via fetch_page (existing behavior).
- Summary pipeline unchanged: Startpage SERP scrape + prefetch stays the primary input; `web_search` is offered to the model in BOTH summaries and follow-ups while tool rounds remain.
- Existing 98 tests keep passing (agent test helpers may be extended, never weakened).
- Work on branch `feature/web-search` off `master`. Version bumps to 0.3.0 in Task 4.

## File Map

| File | Change |
|---|---|
| `src/shared/types.ts` | `Settings` + `DEFAULT_SETTINGS` gain `searchProvider`, `perplexityApiKey` |
| `src/options/options.html` / `options.ts` | Provider dropdown + Perplexity key field |
| `src/offscreen/serp-parse-core.ts` | NEW — pure DDG SERP parser (jsdom-testable) |
| `src/offscreen/offscreen.ts` | Second RPC kind `parse-serp` |
| `src/background/extract.ts` | Export `ensureOffscreen` for reuse |
| `src/background/search.ts` | NEW — provider routing, DDG + Perplexity backends |
| `src/background/prompt.ts` | `WEB_SEARCH_TOOL` + updated system-prompt tool guidance |
| `src/background/agent.ts` | `AgentDeps.searchWeb`; `web_search` tool branch; both tools offered |
| `src/background/index.ts` | Per-job deps bind `searchWeb` with loaded settings |
| `tests/` | `search.test.ts` (new), settings/prompt/agent test extensions |

---

### Task 1: Settings and options UI

**Files:**
- Modify: `src/shared/types.ts` (Settings + DEFAULT_SETTINGS)
- Modify: `src/options/options.html`, `src/options/options.ts`
- Test: `tests/settings.test.ts` (one added test)

**Interfaces:**
- Produces: `Settings.searchProvider: 'ddg' | 'perplexity'` (default `'ddg'`), `Settings.perplexityApiKey: string` (default `''`). Later tasks read both.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('settings', …)` block in `tests/settings.test.ts`:
```ts
  it('defaults include the search provider settings', async () => {
    const s = await loadSettings()
    expect(s.searchProvider).toBe('ddg')
    expect(s.perplexityApiKey).toBe('')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL (`searchProvider` undefined)

- [ ] **Step 3: Implement**

In `src/shared/types.ts`, extend the `Settings` type:
```ts
  searchProvider: 'ddg' | 'perplexity'
  perplexityApiKey: string
```
and `DEFAULT_SETTINGS`:
```ts
  searchProvider: 'ddg',
  perplexityApiKey: '',
```

In `src/options/options.html`, after the systemPromptOverride textarea block and before the Save button, add:
```html
  <label for="searchProvider">Web search backend</label>
  <select id="searchProvider">
    <option value="ddg">DuckDuckGo — free, no key needed</option>
    <option value="perplexity">Perplexity — uses your API key</option>
  </select>
  <div class="hint">Used only when the model calls the web_search tool (e.g. follow-ups needing new information).</div>

  <label for="perplexityApiKey">Perplexity API key (optional)</label>
  <input id="perplexityApiKey" type="password" autocomplete="off">
  <div class="hint">Only used when Perplexity is selected; stored on this device; sent only to api.perplexity.ai. Empty key falls back to DuckDuckGo.</div>
```

In `src/options/options.ts`, add to `restore()`:
```ts
  $<HTMLSelectElement>('searchProvider').value = s.searchProvider
  $<HTMLInputElement>('perplexityApiKey').value = s.perplexityApiKey
```
and to the `patch` object in `save()`:
```ts
    searchProvider: $<HTMLSelectElement>('searchProvider').value as Settings['searchProvider'],
    perplexityApiKey: $<HTMLInputElement>('perplexityApiKey').value.trim(),
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/settings.test.ts` (4 passed), then `npm test && npm run typecheck && npm run build` — all green (99 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/options tests/settings.test.ts
git commit -m "feat: search provider settings and options UI"
```

---

### Task 2: Search providers — DDG parser and Perplexity client

**Files:**
- Create: `src/offscreen/serp-parse-core.ts`, `src/background/search.ts`
- Modify: `src/offscreen/offscreen.ts` (second RPC kind), `src/background/extract.ts` (export `ensureOffscreen`)
- Test: `tests/search.test.ts`

**Interfaces:**
- Consumes: `SerpResult`/`Settings` (shared types), `fetchPage` (fetcher), `ensureOffscreen` (extract).
- Produces:
  ```ts
  // offscreen/serp-parse-core.ts
  parseDdgSerp(html: string): SerpResult[]           // ≤5, ads skipped, uddg redirects unwrapped
  // background/search.ts
  searchWeb(query: string, settings: Settings): Promise<SerpResult[]>   // throws on provider failure
  ```
- Offscreen RPC: `{ target: 'offscreen', kind: 'parse-serp', html }` → `{ ok: true, results: SerpResult[] } | { ok: false, error }`.

- [ ] **Step 1: Write the failing tests**

`tests/search.test.ts`:
```ts
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
  afterEach(() => vi.unstubAllGlobals())

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
```

- [ ] **Step 2: Run tests to verify failures**

Run: `npx vitest run tests/search.test.ts`
Expected: FAIL (modules not found)

- [ ] **Step 3: Implement**

`src/offscreen/serp-parse-core.ts`:
```ts
import type { SerpResult } from '../shared/types'

const MAX_RESULTS = 5

// DDG's html endpoint wraps result links as //duckduckgo.com/l/?uddg=<encoded>&…
function unwrapDdgRedirect(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    const uddg = url.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
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
```

`src/offscreen/offscreen.ts` (replace in full):
```ts
import { extractReadable } from './extract-core'
import { parseDdgSerp } from './serp-parse-core'

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return
  if (msg.kind === 'extract') {
    try {
      sendResponse({ ok: true, ...extractReadable(msg.html, msg.url, msg.charBudget) })
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (msg.kind === 'parse-serp') {
    try {
      sendResponse({ ok: true, results: parseDdgSerp(msg.html) })
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
})
```

`src/background/extract.ts`: change `async function ensureOffscreen` to `export async function ensureOffscreen` (no other changes).

`src/background/search.ts`:
```ts
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
```

Note: `encodeURIComponent('belgium odds')` produces `belgium%20odds` — the DDG routing test asserts that exact form.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/search.test.ts` (8 passed), then `npm test && npm run typecheck && npm run build` — all green (107 tests).

- [ ] **Step 5: Commit**

```bash
git add src/offscreen src/background/search.ts src/background/extract.ts tests/search.test.ts
git commit -m "feat: web search providers — DDG HTML parser and Perplexity Search API"
```

---

### Task 3: Tool definition, prompt, and agent integration

**Files:**
- Modify: `src/background/prompt.ts` (WEB_SEARCH_TOOL + system prompt), `src/background/agent.ts` (deps + tool branch), `src/background/index.ts` (per-job searchWeb binding)
- Test: `tests/prompt.test.ts` (additions), `tests/agent.test.ts` (helper extension + new tests)

**Interfaces:**
- Consumes: `searchWeb(query, settings)` (Task 2), existing agent/prompt structures.
- Produces: `WEB_SEARCH_TOOL` (function tool named `web_search`, required param `query`); `AgentDeps.searchWeb: (query: string) => Promise<SerpResult[]>`; both tools offered while rounds remain in summaries AND follow-ups.

- [ ] **Step 1: Write the failing tests**

Append to `tests/prompt.test.ts` inside the describe block (extend the top import line with `WEB_SEARCH_TOOL`):
```ts
  it('web_search tool definition is a valid function tool', () => {
    expect(WEB_SEARCH_TOOL.type).toBe('function')
    expect(WEB_SEARCH_TOOL.function.name).toBe('web_search')
    expect(WEB_SEARCH_TOOL.function.parameters.required).toContain('query')
  })
  it('system prompt mentions web_search guidance', () => {
    expect(buildSystemPrompt()).toContain('web_search')
  })
```

In `tests/agent.test.ts`: extend the `depsWith` helper to include `searchWeb: vi.fn(async () => [])` (and add `searchWeb` to any inline `AgentDeps` literals in the runFollowup describe block). Then append a new describe:
```ts
describe('web_search tool', () => {
  const searchCall = (id: string, q: string) => ({
    id,
    type: 'function' as const,
    function: { name: 'web_search', arguments: JSON.stringify({ query: q }) },
  })

  it('offers both tools while rounds remain', async () => {
    const { emit } = collect()
    const chat = chatReturning({ content: 'ok', toolCalls: [], finishReason: 'stop' })
    await runAgent('j1', 'q', results, settings, depsWith(chat), emit)
    const tools = (chat as any).mock.calls[0][0].tools
    expect(tools.map((t: any) => t.function.name).sort()).toEqual(['fetch_page', 'web_search'])
  })

  it('runs a search and returns formatted candidates to the model', async () => {
    const { emit } = collect()
    const chat = chatReturning(
      { content: '', toolCalls: [searchCall('s1', 'belgium odds')], finishReason: 'tool_calls' },
      { content: 'ok', toolCalls: [], finishReason: 'stop' },
    )
    const deps = depsWith(chat)
    deps.searchWeb = vi.fn(async () => [{ title: 'Odds', url: 'https://o.com', snippet: 'Belgium favored' }])
    await runAgent('j1', 'q', results, settings, deps, emit)
    expect(deps.searchWeb).toHaveBeenCalledWith('belgium odds')
    const toolMsg = (chat as any).mock.calls[1][0].messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 's1')
    expect(toolMsg.content).toContain('- Odds — https://o.com')
    expect(toolMsg.content).toContain('Belgium favored')
  })

  it('search results never become sources', async () => {
    const { events, emit } = collect()
    const chat = chatReturning(
      { content: '', toolCalls: [searchCall('s1', 'q2')], finishReason: 'tool_calls' },
      { content: 'ok', toolCalls: [], finishReason: 'stop' },
    )
    const deps = depsWith(chat)
    deps.searchWeb = vi.fn(async () => [{ title: 'X', url: 'https://x.com', snippet: 's' }])
    await runAgent('j1', 'q', results, settings, deps, emit)
    const last = events.filter(e => e.type === 'sources').at(-1) as any
    expect(last.sources).toHaveLength(2) // prefetch only; no source added by the search
  })

  it('enforces the 2-search cap per exchange', async () => {
    const { emit } = collect()
    const chat = chatReturning(
      { content: '', toolCalls: [searchCall('a', 'q1'), searchCall('b', 'q2'), searchCall('c', 'q3')], finishReason: 'tool_calls' },
      { content: 'ok', toolCalls: [], finishReason: 'stop' },
    )
    const deps = depsWith(chat)
    deps.searchWeb = vi.fn(async () => [])
    await runAgent('j1', 'q', results, settings, deps, emit)
    expect(deps.searchWeb).toHaveBeenCalledTimes(2)
    const msgs = (chat as any).mock.calls[1][0].messages.filter((m: any) => m.role === 'tool')
    expect(msgs[2].content).toBe('Error: search limit reached; work with what you have.')
  })

  it('maps empty results, failures, and bad args to tool messages', async () => {
    const { emit } = collect()
    const chat = chatReturning(
      {
        content: '',
        toolCalls: [
          searchCall('e1', 'nothing'),
          { id: 'e2', type: 'function' as const, function: { name: 'web_search', arguments: '{"query":""}' } },
        ],
        finishReason: 'tool_calls',
      },
      { content: 'ok', toolCalls: [], finishReason: 'stop' },
    )
    const deps = depsWith(chat)
    deps.searchWeb = vi.fn(async () => [])
    await runAgent('j1', 'q', results, settings, deps, emit)
    const msgs = (chat as any).mock.calls[1][0].messages.filter((m: any) => m.role === 'tool')
    expect(msgs[0].content).toBe('No results found.')
    expect(msgs[1].content).toBe('Error: invalid search query.')
  })

  it('a throwing provider becomes a search-failed tool message', async () => {
    const { emit } = collect()
    const chat = chatReturning(
      { content: '', toolCalls: [searchCall('f1', 'q')], finishReason: 'tool_calls' },
      { content: 'ok', toolCalls: [], finishReason: 'stop' },
    )
    const deps = depsWith(chat)
    deps.searchWeb = vi.fn(async () => { throw new Error('provider down') })
    await runAgent('j1', 'q', results, settings, deps, emit)
    const msg = (chat as any).mock.calls[1][0].messages.find((m: any) => m.role === 'tool')
    expect(msg.content).toBe('Error: search failed.')
  })
})
```

- [ ] **Step 2: Run tests to verify failures**

Run: `npx vitest run tests/prompt.test.ts tests/agent.test.ts`
Expected: FAIL (WEB_SEARCH_TOOL not exported; searchWeb missing from AgentDeps)

- [ ] **Step 3: Implement**

In `src/background/prompt.ts`, add after `FETCH_PAGE_TOOL`:
```ts
export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web for pages relevant to a query. Use when the provided sources cannot answer the question — especially follow-up questions about new aspects — then fetch_page the promising results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
} as const
```
and replace the fetch_page rule line in `SYSTEM_PROMPT` with:
```
- You may call web_search to find pages when the question needs information beyond the provided sources — especially follow-up questions about new aspects — and fetch_page to read search results or links referenced in a source. Prefer searching and reading over telling the user to look elsewhere. Do not call tools when you already have enough.
```

In `src/background/agent.ts`:
1. Extend `AgentDeps`:
```ts
  searchWeb: (query: string) => Promise<SerpResult[]>
```
2. Add constants + arg parser near `parseUrlArg`:
```ts
const MAX_SEARCHES = 2

function parseQueryArg(raw: string): string | null {
  try {
    const q = JSON.parse(raw)?.query
    return typeof q === 'string' && q.trim() ? q.trim() : null
  } catch {
    return null
  }
}
```
3. Import `WEB_SEARCH_TOOL` alongside `FETCH_PAGE_TOOL`; change the tools spread in `executeExchange` to:
```ts
        ...(offerTools ? { tools: [FETCH_PAGE_TOOL, WEB_SEARCH_TOOL] } : {}),
```
4. Add `let searchesUsed = 0` next to `let pagesFetched = …` inside the try block, and insert a `web_search` branch in the tool-call handling (before the existing `if (call.function.name !== 'fetch_page')` unknown-tool arm — restructure as name-based dispatch):
```ts
      for (const call of turn.toolCalls) {
        let resultText: string
        if (call.function.name === 'web_search') {
          const q = parseQueryArg(call.function.arguments)
          if (!q) {
            resultText = 'Error: invalid search query.'
          } else if (searchesUsed >= MAX_SEARCHES) {
            resultText = 'Error: search limit reached; work with what you have.'
          } else {
            searchesUsed++
            try {
              const found = await budgetRace(deps.searchWeb(q))
              resultText = found.length
                ? `Search results for "${q}":\n` +
                  found.map(r => `- ${r.title} — ${r.url}\n  ${r.snippet}`).join('\n')
                : 'No results found.'
            } catch (searchErr) {
              // A budget-abort must propagate to the exchange-level handler;
              // only genuine provider failures become tool messages.
              if (abort.signal.aborted) throw searchErr
              resultText = 'Error: search failed.'
            }
          }
        } else if (call.function.name !== 'fetch_page') {
          resultText = 'Error: unknown tool.'
        } else {
          // …existing fetch_page branch unchanged…
        }
        messages.push({ role: 'tool', content: resultText, tool_call_id: call.id })
      }
```

In `src/background/index.ts`: import `searchWeb` from `./search`; inside the port message handler after `const settings = await loadSettings()`, build per-job deps and pass them to both runners:
```ts
    const jobDeps: AgentDeps = { ...deps, searchWeb: (q: string) => searchWeb(q, settings) }
```
(replace `deps` with `jobDeps` in the `runAgent`/`runFollowup` calls). The module-level `deps` gains a placeholder that satisfies the type:
```ts
  searchWeb: async () => [],
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/prompt.test.ts tests/agent.test.ts` (all pass incl. 6 new agent + 2 new prompt tests), then `npm test && npm run typecheck && npm run build` — all green (115 tests).

- [ ] **Step 5: Commit**

```bash
git add src/background/prompt.ts src/background/agent.ts src/background/index.ts tests/prompt.test.ts tests/agent.test.ts
git commit -m "feat: web_search tool in the agent loop with per-exchange cap"
```

---

### Task 4: E2E verification, version bump, README

**Files:**
- Modify: `src/manifest.json` + `package.json` (version → `0.3.0`), `README.md`

Manual verification with the user in the loop.

- [ ] **Step 1: Version bump + README**

Set `"version": "0.3.0"` in both manifests. In README.md, after the follow-up chat paragraph add:

> When the model needs information beyond the crawled sources — typical for follow-up questions — it can call a `web_search` tool (max 2 searches per exchange) and then read the promising results. The search backend is configurable in options: DuckDuckGo's HTML endpoint (free, default) or the Perplexity Search API with your own key.

In the Security notes section add: "Search queries are sent to the selected search backend (DuckDuckGo or Perplexity) only when the model invokes web_search. The Perplexity key is stored on-device and sent only to api.perplexity.ai."

- [ ] **Step 2: Build + reload**

`npm run build`; reload the extension in `vivaldi://extensions`.

- [ ] **Step 3: E2E checklist (user-verified)**

- DDG path (default): run a summary, ask a drifted follow-up ("who's the favorite in the X game?" style) → model searches, source strip grows with newly fetched pages, answer cites them.
- Options: switch backend to Perplexity, paste the real key, Save.
- Perplexity path: repeat a drifted follow-up → same behavior via Perplexity (check the background service-worker console for the api.perplexity.ai request if in doubt).
- Remove the key but leave Perplexity selected → follow-up still works (silent DDG fallback).

- [ ] **Step 4: Commit + finish**

```bash
git add src/manifest.json package.json README.md
git commit -m "chore: v0.3.0 — web_search tool"
```
Then finishing-a-development-branch (merge to master, push).

---

## Self-Review Notes

- **Spec coverage:** tool semantics + exact strings + caps (T3), provider abstraction/DDG parser/uddg unwrap/Perplexity mapping + fallback + timeouts (T2), settings + options UI + key hint (T1), prompt guidance (T3), candidates-never-sources (T3 test), summaries AND follow-ups get the tool (T3: tools spread lives in the shared executeExchange), README/privacy + version + E2E (T4). Out-of-scope items absent.
- **Type consistency:** `searchWeb(query, settings)` (search.ts) vs `AgentDeps.searchWeb(query)` (settings pre-bound in index.ts) — deliberate, documented in T3. `SerpResult` reused everywhere. `parseDdgSerp` name identical in offscreen.ts import and tests.
- **Judgment calls:** the runFollowup path needs no changes in T3 beyond the deps type — both runners share `executeExchange`, which is where tools are offered; the abort-propagation guard in the search catch keeps budget semantics identical to fetch_page's.
