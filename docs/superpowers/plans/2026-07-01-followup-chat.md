# Follow-up Chat (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand a finished AI overview card into an inline chat: follow-up questions stream citation-grounded answers from the same model, with `fetch_page` tool access, persisted in `chrome.storage.session` and restored on reload.

**Architecture:** The agent's streaming tool loop is extracted into a reusable `executeExchange`; `runAgent` (summary) and new `runFollowup` both call it and persist the conversation via an injected transcript store backed by `chrome.storage.session`. The panel generalizes its single markdown accumulator into per-exchange render blocks and gains a chat input. Content script threads a `jobId` through the port protocol and restores conversations via a one-shot background message.

**Tech Stack:** unchanged — TypeScript strict, esbuild, vitest + jsdom, `@mozilla/readability`.

**Spec:** `docs/superpowers/specs/2026-07-01-followup-chat-design.md`

## Global Constraints

- Caps per exchange (summary AND each follow-up): 8 pages, 3 tool rounds, 45 s — the existing `MAX_TOOL_ROUNDS`/`MAX_TOTAL_PAGES`/`OVERALL_BUDGET_MS` constants.
- Conversation storage: `chrome.storage.session` ONLY. Keys `wc:job:<jobId>` and `wc:query:<normalized query>`. Keep the **5** most recent conversations.
- Content scripts must NOT touch `chrome.storage.session` (trusted-contexts-only) — restore goes through `{ target: 'background', kind: 'get-conversation', query }`.
- Expired-conversation error message, verbatim: `Conversation expired — regenerate to start fresh.`
- Save failures are non-fatal (answer still renders).
- Model output reaches the DOM only via `renderMarkdown` or `textContent` — unchanged from v1.
- Existing 68 tests must keep passing; where a test asserts DOM structure that legitimately changed (panel internals), update the assertion but preserve the behavior it proves.
- All work on branch `feature/followup-chat` off `master`.

## File Map

| File | Change |
|---|---|
| `src/shared/types.ts` | `JobRequest` union gains `jobId` + new `followup` variant; new `DisplayMessage` |
| `src/background/transcript.ts` | NEW — conversation store (save/load/find-by-query/prune) |
| `src/background/agent.ts` | extract `executeExchange`; `runAgent` gains `jobId` + transcript save; new `runFollowup`; `AgentDeps` gains `transcripts` |
| `src/background/index.ts` | route `followup`; `get-conversation` handler; wire real transcript store |
| `src/content/panel.ts` | per-exchange rendering, chat input, `addUserMessage`/`beginExchange`/`enableChat`/`restore` |
| `src/content/index.ts` | jobId threading, restore path, `startFollowup`, shared `wirePort` |
| `src/manifest.json` | version 0.2.0 (Task 7) |

---

### Task 1: Protocol types and transcript store

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/content/index.ts:18` (one-line compile fix only)
- Create: `src/background/transcript.ts`
- Test: `tests/transcript.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` from `src/background/llm.ts`, `ExtractedSource` from `src/shared/types.ts`.
- Produces:
  ```ts
  // shared/types.ts
  type JobRequest =
    | { type: 'run'; jobId: string; query: string; results: SerpResult[] }
    | { type: 'followup'; jobId: string; question: string }
  type DisplayMessage = { role: 'user' | 'assistant'; markdown: string }

  // background/transcript.ts
  type ConversationRecord = {
    jobId: string
    query: string
    messages: ChatMessage[]
    sources: ExtractedSource[]
    display: DisplayMessage[]
    updatedAt: number
  }
  normalizeQuery(q: string): string
  saveConversation(rec: ConversationRecord): Promise<void>
  loadConversation(jobId: string): Promise<ConversationRecord | null>
  findConversationByQuery(query: string): Promise<ConversationRecord | null>
  ```

- [ ] **Step 1: Write the failing test**

`tests/transcript.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findConversationByQuery,
  loadConversation,
  normalizeQuery,
  saveConversation,
  type ConversationRecord,
} from '../src/background/transcript'

const store: Record<string, unknown> = {}

vi.stubGlobal('chrome', {
  storage: {
    session: {
      get: async (key: string | null) => {
        if (key === null) return { ...store }
        return store[key] === undefined ? {} : { [key]: store[key] }
      },
      set: async (obj: Record<string, unknown>) => { Object.assign(store, obj) },
      remove: async (keys: string[]) => { for (const k of keys) delete store[k] },
    },
  },
})

beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

const rec = (jobId: string, query: string, updatedAt: number): ConversationRecord => ({
  jobId,
  query,
  messages: [{ role: 'user', content: 'q' }],
  sources: [{ index: 1, url: 'https://a.com', title: 'A', ok: true, text: 'body' }],
  display: [{ role: 'assistant', markdown: 'answer' }],
  updatedAt,
})

describe('transcript store', () => {
  it('normalizes queries (trim, lowercase, collapse whitespace)', () => {
    expect(normalizeQuery('  How  Do HEAT pumps\twork ')).toBe('how do heat pumps work')
  })

  it('round-trips a conversation by jobId', async () => {
    await saveConversation(rec('j1', 'heat pumps', 100))
    const loaded = await loadConversation('j1')
    expect(loaded?.jobId).toBe('j1')
    expect(loaded?.display[0].markdown).toBe('answer')
  })

  it('returns null for unknown jobId', async () => {
    expect(await loadConversation('nope')).toBeNull()
  })

  it('finds a conversation by query, normalized', async () => {
    await saveConversation(rec('j1', 'Heat Pumps', 100))
    const found = await findConversationByQuery('  heat   pumps ')
    expect(found?.jobId).toBe('j1')
  })

  it('returns null when no conversation exists for a query', async () => {
    expect(await findConversationByQuery('unknown')).toBeNull()
  })

  it('prunes to the 5 most recent conversations including query index entries', async () => {
    for (let i = 1; i <= 7; i++) await saveConversation(rec(`j${i}`, `query ${i}`, i))
    expect(await loadConversation('j1')).toBeNull()
    expect(await loadConversation('j2')).toBeNull()
    expect(await loadConversation('j3')).not.toBeNull()
    expect(await loadConversation('j7')).not.toBeNull()
    expect(await findConversationByQuery('query 1')).toBeNull()
    expect(await findConversationByQuery('query 7')).not.toBeNull()
  })

  it('saving the same query twice repoints the index to the newest job', async () => {
    await saveConversation(rec('j-old', 'same query', 100))
    await saveConversation(rec('j-new', 'same query', 200))
    expect((await findConversationByQuery('same query'))?.jobId).toBe('j-new')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcript.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write the types change**

In `src/shared/types.ts`, replace the existing `JobRequest` type with:
```ts
export type JobRequest =
  | { type: 'run'; jobId: string; query: string; results: SerpResult[] }
  | { type: 'followup'; jobId: string; question: string }

export type DisplayMessage = { role: 'user' | 'assistant'; markdown: string }
```

In `src/content/index.ts`, line 18, make the existing postMessage compile against the new union (full threading arrives in Task 6):
```ts
  port.postMessage({ type: 'run', jobId: crypto.randomUUID(), query, results })
```

(`src/background/index.ts` needs no change yet: its `msg?.type !== 'run'` guard narrows the union correctly.)

- [ ] **Step 4: Write the transcript store**

`src/background/transcript.ts`:
```ts
import type { DisplayMessage, ExtractedSource } from '../shared/types'
import type { ChatMessage } from './llm'

export type ConversationRecord = {
  jobId: string
  query: string
  messages: ChatMessage[]
  sources: ExtractedSource[]
  display: DisplayMessage[]
  updatedAt: number
}

const JOB_PREFIX = 'wc:job:'
const QUERY_PREFIX = 'wc:query:'
const MAX_CONVERSATIONS = 5

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

export async function saveConversation(rec: ConversationRecord): Promise<void> {
  await chrome.storage.session.set({
    [JOB_PREFIX + rec.jobId]: rec,
    [QUERY_PREFIX + normalizeQuery(rec.query)]: rec.jobId,
  })
  await prune()
}

export async function loadConversation(jobId: string): Promise<ConversationRecord | null> {
  const key = JOB_PREFIX + jobId
  const stored = await chrome.storage.session.get(key)
  return (stored[key] as ConversationRecord | undefined) ?? null
}

export async function findConversationByQuery(query: string): Promise<ConversationRecord | null> {
  const key = QUERY_PREFIX + normalizeQuery(query)
  const stored = await chrome.storage.session.get(key)
  const jobId = stored[key] as string | undefined
  return jobId ? loadConversation(jobId) : null
}

async function prune(): Promise<void> {
  const all = await chrome.storage.session.get(null)
  const jobs = Object.entries(all)
    .filter(([k]) => k.startsWith(JOB_PREFIX))
    .map(([, v]) => v as ConversationRecord)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const stale = jobs.slice(MAX_CONVERSATIONS)
  if (!stale.length) return
  const keys = stale.flatMap(r => [JOB_PREFIX + r.jobId, QUERY_PREFIX + normalizeQuery(r.query)])
  await chrome.storage.session.remove(keys)
}
```

- [ ] **Step 5: Run tests, typecheck, full suite**

Run: `npx vitest run tests/transcript.test.ts` — Expected: 7 passed
Run: `npm run typecheck && npm test` — Expected: clean; 75 total tests pass

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/content/index.ts src/background/transcript.ts tests/transcript.test.ts
git commit -m "feat: conversation transcript store and follow-up protocol types"
```

---

### Task 2: Agent refactor — reusable exchange + transcript saving

**Files:**
- Modify: `src/background/agent.ts` (full replacement below)
- Modify: `tests/agent.test.ts` (signature + deps updates; new save tests)

**Interfaces:**
- Consumes: `ConversationRecord` from Task 1; everything agent.ts already imports.
- Produces (Tasks 3, 4 rely on these exactly):
  ```ts
  type TranscriptStore = {
    load(jobId: string): Promise<ConversationRecord | null>
    save(rec: ConversationRecord): Promise<void>
  }
  type AgentDeps = {
    fetchAndExtract: (url: string, charBudget: number) => Promise<{ title: string; text: string } | null>
    streamChat: typeof streamChatFn
    transcripts: TranscriptStore
  }
  runAgent(jobId: string, query: string, results: SerpResult[], settings: Settings, deps: AgentDeps, emit: Emit): Promise<void>
  ```
- Behavior contract: identical event stream to v1 for summaries; on success, saves `{ jobId, query, messages (incl. final assistant answer), sources, display: [{ role: 'assistant', markdown: answer }], updatedAt }`. Save failures swallowed.

- [ ] **Step 1: Update existing tests and add the failing save tests**

In `tests/agent.test.ts`:
1. Add a fake transcript store helper near the top:
```ts
const fakeTranscripts = () => ({
  load: vi.fn(async () => null),
  save: vi.fn(async () => {}),
})
```
2. Every `AgentDeps` object literal gains `transcripts: fakeTranscripts()` (or a shared `const transcripts = fakeTranscripts()` per test where the test asserts on it).
3. Every `runAgent(...)` call gains a leading jobId argument: `runAgent('job-1', 'how do heat pumps work', results, settings, deps, emit)` etc.
4. Append these new tests inside `describe('runAgent', ...)`:
```ts
  it('saves the conversation transcript on success', async () => {
    const { emit } = collect()
    const transcripts = { load: vi.fn(async () => null), save: vi.fn(async () => {}) }
    const deps: AgentDeps = {
      fetchAndExtract: vi.fn(okExtract),
      streamChat: chatReturning({ content: 'Answer [1].', toolCalls: [], finishReason: 'stop' }),
      transcripts,
    }
    await runAgent('job-1', 'how do heat pumps work', results, settings, deps, emit)
    expect(transcripts.save).toHaveBeenCalledTimes(1)
    const rec = (transcripts.save as any).mock.calls[0][0]
    expect(rec.jobId).toBe('job-1')
    expect(rec.query).toBe('how do heat pumps work')
    expect(rec.messages.at(-1)).toEqual({ role: 'assistant', content: 'Answer [1].' })
    expect(rec.display).toEqual([{ role: 'assistant', markdown: 'Answer [1].' }])
    expect(rec.sources).toHaveLength(2)
  })

  it('does not save when the run errors', async () => {
    const { emit } = collect()
    const transcripts = { load: vi.fn(async () => null), save: vi.fn(async () => {}) }
    const chat = vi.fn(async () => { throw new Error('boom') }) as unknown as typeof streamChat
    await runAgent('job-1', 'q', results, settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts }, emit)
    expect(transcripts.save).not.toHaveBeenCalled()
  })

  it('a failing save is non-fatal (done already emitted, no throw)', async () => {
    const { events, emit } = collect()
    const transcripts = { load: vi.fn(async () => null), save: vi.fn(async () => { throw new Error('quota') }) }
    const deps: AgentDeps = {
      fetchAndExtract: vi.fn(okExtract),
      streamChat: chatReturning({ content: 'ok', toolCalls: [], finishReason: 'stop' }),
      transcripts,
    }
    await expect(runAgent('job-1', 'q', results, settings, deps, emit)).resolves.toBeUndefined()
    expect(events.at(-1)).toEqual({ type: 'done' })
  })
```

- [ ] **Step 2: Run to verify new tests fail**

Run: `npx vitest run tests/agent.test.ts`
Expected: FAIL (runAgent has no jobId param / transcripts missing from AgentDeps)

- [ ] **Step 3: Replace `src/background/agent.ts`**

Full new content (this is a refactor of the current file — the tool loop, caps, budget race, and catch semantics are preserved verbatim inside `executeExchange`):
```ts
import type { ExtractedSource, SerpResult, Settings, StreamEvent } from '../shared/types'
import type { ChatMessage, streamChat as streamChatFn } from './llm'
import { FETCH_PAGE_TOOL, buildSystemPrompt, buildUserMessage } from './prompt'
import type { ConversationRecord } from './transcript'

export type Emit = (e: StreamEvent) => void

export type TranscriptStore = {
  load(jobId: string): Promise<ConversationRecord | null>
  save(rec: ConversationRecord): Promise<void>
}

export type AgentDeps = {
  fetchAndExtract: (url: string, charBudget: number) => Promise<{ title: string; text: string } | null>
  streamChat: typeof streamChatFn
  transcripts: TranscriptStore
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
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
  } catch {
    return null
  }
}

type Race = <T>(p: Promise<T>) => Promise<T>

// One complete model exchange: optional preparation (prefetch) inside the time
// budget, then the capped streaming tool loop. Owns the 45s budget, token
// bookkeeping, and the done/error emission semantics. Returns the streamed
// answer text and whether the exchange ended with a `done` event.
async function executeExchange(opts: {
  messages: ChatMessage[]
  sources: ExtractedSource[]
  settings: Settings
  deps: AgentDeps
  emit: Emit
  // Runs inside the budget before the loop; returns pages already consumed
  // this exchange (the prefetch count for summaries; omit for follow-ups).
  prepare?: (race: Race) => Promise<number>
}): Promise<{ ok: boolean; answer: string }> {
  const { messages, sources, settings, deps, emit } = opts
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), OVERALL_BUDGET_MS)
  let tokensEmitted = false
  let answer = ''

  // A single lazily-created promise that rejects when the overall time budget is
  // exceeded. Raced against every fetchAndExtract call so a hung fetch can't stall
  // the exchange forever. Given a no-op catch so an unconsumed rejection (the common
  // case, since most calls finish before the budget) never surfaces as unhandled.
  let timeoutPromise: Promise<never> | null = null
  const budgetRace: Race = p => {
    if (!timeoutPromise) {
      timeoutPromise = new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(new Error('Time budget exceeded.')), { once: true })
      })
      timeoutPromise.catch(() => {})
    }
    return Promise.race([p, timeoutPromise])
  }

  try {
    let pagesFetched = opts.prepare ? await opts.prepare(budgetRace) : 0
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // Only offer the tool while rounds remain; the final round is answer-only so
      // the model can't dead-end on a tool call that streams no content.
      const offerTools = round < MAX_TOOL_ROUNDS
      const turn = await deps.streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages,
        ...(offerTools ? { tools: [FETCH_PAGE_TOOL] } : {}),
        signal: abort.signal,
        onToken: t => {
          tokensEmitted = true
          answer += t
          emit({ type: 'token', text: t })
        },
      })
      if (!turn.toolCalls.length || round === MAX_TOOL_ROUNDS) break

      messages.push({ role: 'assistant', content: turn.content || null, tool_calls: turn.toolCalls })
      for (const call of turn.toolCalls) {
        let resultText: string
        if (call.function.name !== 'fetch_page') {
          resultText = 'Error: unknown tool.'
        } else {
          const url = parseUrlArg(call.function.arguments)
          const existing = url ? sources.find(s => s.url === url) : undefined
          if (existing) {
            resultText = `Already fetched as [${existing.index}].`
          } else if (pagesFetched >= MAX_TOTAL_PAGES) {
            resultText = 'Error: total page limit reached; answer with what you have.'
          } else {
            const ex = url ? await budgetRace(deps.fetchAndExtract(url, settings.pageCharBudget)) : null
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
        }
        messages.push({ role: 'tool', content: resultText, tool_call_id: call.id })
      }
    }
    emit({ type: 'done' })
    return { ok: true, answer }
  } catch (err) {
    if (abort.signal.aborted) {
      // Time budget exhausted: per spec, abort remaining work and finish with
      // whatever streamed rather than dropping the user's partial answer.
      if (tokensEmitted) {
        emit({ type: 'done' })
        return { ok: true, answer }
      }
      emit({ type: 'error', message: 'Time budget exceeded before a response could be produced.' })
    } else {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    return { ok: false, answer }
  } finally {
    clearTimeout(timer)
  }
}

export async function runAgent(
  jobId: string,
  query: string,
  results: SerpResult[],
  settings: Settings,
  deps: AgentDeps,
  emit: Emit,
): Promise<void> {
  const sources: ExtractedSource[] = []
  const messages: ChatMessage[] = []

  const { ok, answer } = await executeExchange({
    messages,
    sources,
    settings,
    deps,
    emit,
    prepare: async race => {
      emit({ type: 'status', message: 'Reading sources…' })
      const top = results.slice(0, settings.maxPrefetch)
      const fetched = await Promise.all(
        top.map(async (r, i) => {
          const ex = await race(deps.fetchAndExtract(r.url, settings.pageCharBudget))
          const okSource = !!ex && ex.text.length >= MIN_USEFUL_CHARS
          return {
            index: i + 1,
            url: r.url,
            title: ex?.title || r.title,
            ok: okSource,
            text: okSource ? ex!.text : '',
          }
        }),
      )
      sources.push(...fetched)

      if (!sources.some(s => s.ok)) {
        // snippet-only fallback, labeled via status so the panel can note it
        top.forEach((r, i) => {
          sources[i] = { ...sources[i], text: r.snippet, ok: r.snippet.length > 0 }
        })
        emit({ type: 'status', message: 'Pages unavailable — summarizing search snippets only' })
      }
      emit({ type: 'sources', sources: toInfo(sources) })

      messages.push(
        { role: 'system', content: buildSystemPrompt(settings.systemPromptOverride || undefined) },
        { role: 'user', content: buildUserMessage(query, sources) },
      )
      return sources.length
    },
  })

  if (ok && answer) {
    messages.push({ role: 'assistant', content: answer })
    try {
      await deps.transcripts.save({
        jobId,
        query,
        messages,
        sources,
        display: [{ role: 'assistant', markdown: answer }],
        updatedAt: Date.now(),
      })
    } catch {
      // Non-fatal per spec: the answer already rendered; the conversation just
      // won't survive a service-worker restart.
    }
  }
}
```

(`runFollowup` arrives in Task 3 — do not add it here.)

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run tests/agent.test.ts` — Expected: 12 passed (9 updated + 3 new)
Run: `npm test && npm run typecheck` — Expected: 78 total, clean. Note: `src/background/index.ts` still calls `runAgent(msg.query, ...)` — it must be updated to `runAgent(msg.jobId, msg.query, ...)` with a `transcripts` entry in `deps` (`transcripts: { load: loadConversation, save: saveConversation }` imported from `./transcript`) for typecheck to pass. Make exactly that minimal edit in this task; full routing lands in Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/background/agent.ts src/background/index.ts tests/agent.test.ts
git commit -m "refactor: extract reusable exchange loop; runAgent persists transcripts"
```

---

### Task 3: runFollowup

**Files:**
- Modify: `src/background/agent.ts` (append one export)
- Test: `tests/agent.test.ts` (new describe block)

**Interfaces:**
- Produces: `runFollowup(jobId: string, question: string, settings: Settings, deps: AgentDeps, emit: Emit): Promise<void>`
- Behavior: load transcript (missing → error event `Conversation expired — regenerate to start fresh.`); re-emit current sources; append user question; run `executeExchange` (no prepare → page budget starts at 0); on success append assistant answer to `messages`, push `{user, assistant}` pair onto `display`, bump `updatedAt`, save (failures swallowed). On error the record is NOT saved, so a retry re-appends the question cleanly.

- [ ] **Step 1: Write the failing tests**

Append to `tests/agent.test.ts` (import `runFollowup` alongside `runAgent`):
```ts
describe('runFollowup', () => {
  const baseRecord = () => ({
    jobId: 'job-1',
    query: 'how do heat pumps work',
    messages: [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'sources + query' },
      { role: 'assistant' as const, content: 'Summary [1].' },
    ],
    sources: [
      { index: 1, url: 'https://a.com', title: 'A', ok: true, text: 'a text' },
      { index: 2, url: 'https://b.com', title: 'B', ok: true, text: 'b text' },
    ],
    display: [{ role: 'assistant' as const, markdown: 'Summary [1].' }],
    updatedAt: 100,
  })

  it('emits error when the conversation is missing', async () => {
    const { events, emit } = collect()
    const transcripts = { load: vi.fn(async () => null), save: vi.fn(async () => {}) }
    const chat = vi.fn() as unknown as typeof streamChat
    await runFollowup('gone', 'why?', settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts }, emit)
    expect(events).toEqual([{ type: 'error', message: 'Conversation expired — regenerate to start fresh.' }])
    expect(chat).not.toHaveBeenCalled()
  })

  it('appends the question, streams the answer, and saves the grown transcript', async () => {
    const { events, emit } = collect()
    const transcripts = { load: vi.fn(async () => baseRecord()), save: vi.fn(async () => {}) }
    const chat = chatReturning({ content: 'Because physics [2].', toolCalls: [], finishReason: 'stop' })
    await runFollowup('job-1', 'why is it efficient?', settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts }, emit)

    // sources re-announced first so a restored panel gets its citation map
    expect(events[0]).toMatchObject({ type: 'sources' })
    expect((events[0] as any).sources).toHaveLength(2)
    // question reached the model
    const sentMessages = (chat as any).mock.calls[0][0].messages
    expect(sentMessages.at(-1)).toEqual({ role: 'user', content: 'why is it efficient?' })
    // streamed and finished
    expect(events.filter(e => e.type === 'token').map(e => (e as any).text).join('')).toBe('Because physics [2].')
    expect(events.at(-1)).toEqual({ type: 'done' })
    // saved with question + answer appended to both transcripts
    const saved = (transcripts.save as any).mock.calls[0][0]
    expect(saved.messages.at(-2)).toEqual({ role: 'user', content: 'why is it efficient?' })
    expect(saved.messages.at(-1)).toEqual({ role: 'assistant', content: 'Because physics [2].' })
    expect(saved.display.at(-2)).toEqual({ role: 'user', markdown: 'why is it efficient?' })
    expect(saved.display.at(-1)).toEqual({ role: 'assistant', markdown: 'Because physics [2].' })
    expect(saved.updatedAt).toBeGreaterThan(100)
  })

  it('can crawl new pages in a follow-up; sources grow with continued indices', async () => {
    const { events, emit } = collect()
    const transcripts = { load: vi.fn(async () => baseRecord()), save: vi.fn(async () => {}) }
    const chat = chatReturning(
      {
        content: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://c.com"}' } }],
        finishReason: 'tool_calls',
      },
      { content: 'Deeper [3].', toolCalls: [], finishReason: 'stop' },
    )
    const fetchAndExtract = vi.fn(okExtract)
    await runFollowup('job-1', 'what about costs?', settings, { fetchAndExtract, streamChat: chat, transcripts }, emit)
    expect(fetchAndExtract).toHaveBeenCalledWith('https://c.com', settings.pageCharBudget)
    const lastSources = events.filter(e => e.type === 'sources').at(-1) as any
    expect(lastSources.sources).toHaveLength(3)
    expect(lastSources.sources[2].index).toBe(3)
    const saved = (transcripts.save as any).mock.calls[0][0]
    expect(saved.sources).toHaveLength(3)
  })

  it('does not save when the follow-up errors', async () => {
    const { emit } = collect()
    const transcripts = { load: vi.fn(async () => baseRecord()), save: vi.fn(async () => {}) }
    const chat = vi.fn(async () => { throw new Error('boom') }) as unknown as typeof streamChat
    await runFollowup('job-1', 'q2', settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts }, emit)
    expect(transcripts.save).not.toHaveBeenCalled()
  })

  it('a failing save is non-fatal', async () => {
    const { events, emit } = collect()
    const transcripts = { load: vi.fn(async () => baseRecord()), save: vi.fn(async () => { throw new Error('quota') }) }
    const chat = chatReturning({ content: 'ok', toolCalls: [], finishReason: 'stop' })
    await expect(
      runFollowup('job-1', 'q2', settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts }, emit),
    ).resolves.toBeUndefined()
    expect(events.at(-1)).toEqual({ type: 'done' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/agent.test.ts`
Expected: FAIL (`runFollowup` not exported)

- [ ] **Step 3: Implement**

Append to `src/background/agent.ts`:
```ts
export async function runFollowup(
  jobId: string,
  question: string,
  settings: Settings,
  deps: AgentDeps,
  emit: Emit,
): Promise<void> {
  const rec = await deps.transcripts.load(jobId)
  if (!rec) {
    emit({ type: 'error', message: 'Conversation expired — regenerate to start fresh.' })
    return
  }

  // Re-announce current sources so a freshly restored panel has its citation map.
  emit({ type: 'sources', sources: toInfo(rec.sources) })

  rec.messages.push({ role: 'user', content: question })
  const { ok, answer } = await executeExchange({
    messages: rec.messages,
    sources: rec.sources,
    settings,
    deps,
    emit,
  })

  if (ok && answer) {
    rec.messages.push({ role: 'assistant', content: answer })
    rec.display.push({ role: 'user', markdown: question }, { role: 'assistant', markdown: answer })
    rec.updatedAt = Date.now()
    try {
      await deps.transcripts.save(rec)
    } catch {
      // Non-fatal per spec.
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agent.test.ts` — Expected: 17 passed
Run: `npm test && npm run typecheck` — Expected: 83 total, clean

- [ ] **Step 5: Commit**

```bash
git add src/background/agent.ts tests/agent.test.ts
git commit -m "feat: runFollowup — grounded follow-up exchanges over stored transcripts"
```

---

### Task 4: Background routing

**Files:**
- Modify: `src/background/index.ts` (full replacement below)

**Interfaces:**
- Consumes: `runFollowup` (Task 3), `findConversationByQuery` (Task 1).
- Produces: port accepts both `run` and `followup` JobRequests; one-shot message `{ target: 'background', kind: 'get-conversation', query }` → `{ jobId, display, sources: SourceInfo[] } | null` (source text stripped).

- [ ] **Step 1: Replace `src/background/index.ts`**

```ts
import type { JobRequest, StreamEvent } from '../shared/types'
import { loadSettings } from '../shared/settings'
import { runAgent, runFollowup, type AgentDeps } from './agent'
import { extractInOffscreen } from './extract'
import { fetchPage } from './fetcher'
import { streamChat } from './llm'
import { findConversationByQuery, loadConversation, saveConversation } from './transcript'

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
  transcripts: { load: loadConversation, save: saveConversation },
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
    if (msg?.type !== 'run' && msg?.type !== 'followup') return
    const settings = await loadSettings()
    if (!settings.apiKey || !settings.model) {
      emit({ type: 'error', message: 'Not configured — set your endpoint, API key and model in Webcrawla options.' })
      return
    }
    const keepalive = setInterval(() => { void chrome.storage.local.get('keepalive') }, 20_000)
    try {
      if (msg.type === 'run') {
        await runAgent(msg.jobId, msg.query, msg.results, settings, deps, emit)
      } else {
        await runFollowup(msg.jobId, msg.question, settings, deps, emit)
      }
    } finally {
      clearInterval(keepalive)
    }
  })
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return
  if (msg.kind === 'open-options') {
    void chrome.runtime.openOptionsPage()
    return
  }
  if (msg.kind === 'get-conversation' && typeof msg.query === 'string') {
    void findConversationByQuery(msg.query).then(rec => {
      sendResponse(
        rec
          ? {
              jobId: rec.jobId,
              display: rec.display,
              sources: rec.sources.map(({ text: _text, ...info }) => info),
            }
          : null,
      )
    })
    return true // async sendResponse
  }
})
```

- [ ] **Step 2: Verify build, typecheck, suite**

Run: `npm run build && npm run typecheck && npm test`
Expected: all green (83 tests).

- [ ] **Step 3: Commit**

```bash
git add src/background/index.ts
git commit -m "feat: route follow-up jobs and conversation restore in background worker"
```

---

### Task 5: Panel — per-exchange rendering and chat UI

**Files:**
- Modify: `src/content/panel.ts` (full replacement below)
- Modify: `tests/panel.test.ts` (existing behavioral tests may need DOM-structure updates; behaviors preserved. New tests below.)

**Interfaces:**
- Produces (Task 6 relies on these exactly):
  ```ts
  type Panel = {
    setSetup(): void
    setIdle(onRun: () => void): void
    setLoading(message: string): void
    setSources(sources: SourceInfo[]): void
    appendToken(text: string): void
    finish(onRerun?: () => void): void
    setError(message: string, onRetry: () => void): void
    addUserMessage(text: string): void
    beginExchange(): void
    enableChat(onAsk: (question: string) => void): void
    restore(display: DisplayMessage[], sources: SourceInfo[]): void
  }
  ```
- Semantics: the summary is exchange 0 (created implicitly by `setLoading`/`appendToken` when none exists). `beginExchange` starts a follow-up answer block and disables the chat input. `setError` renders into the current exchange with a Retry button; Retry removes that block before invoking the callback. `finish` renders the current exchange (tolerates none — the restore path), re-enables chat, and (given `onRerun`) shows Regenerate, which clears the whole card. `restore` renders a display transcript without any job running.

- [ ] **Step 1: Replace `src/content/panel.ts`**

```ts
import type { DisplayMessage, SourceInfo } from '../shared/types'
import { renderMarkdown } from './markdown'

export type Panel = {
  setSetup(): void
  setIdle(onRun: () => void): void
  setLoading(message: string): void
  setSources(sources: SourceInfo[]): void
  appendToken(text: string): void
  finish(onRerun?: () => void): void
  setError(message: string, onRetry: () => void): void
  addUserMessage(text: string): void
  beginExchange(): void
  enableChat(onAsk: (question: string) => void): void
  restore(display: DisplayMessage[], sources: SourceInfo[]): void
}

const CSS = `
:host { all: initial; display: block; }
.card { font: 14px/1.55 system-ui, -apple-system, sans-serif; color: #1a1a1a; background: #fff;
  border: 1px solid #dcdfe4; border-radius: 12px; padding: 14px 16px; margin: 0 0 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06); }
@media (prefers-color-scheme: dark) {
  .card { background: #1e2128; color: #e6e6e6; border-color: #3a3f4a; }
  .card a { color: #8ab4f8; }
  .chatrow input { background: #2a2e37; color: #e6e6e6; border-color: #3a3f4a; }
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
.user-q { font-weight: 600; margin: 12px 0 6px; padding: 8px 10px; background: rgba(127,127,127,.08); border-radius: 8px; }
.chatrow { display: flex; gap: 8px; margin-top: 12px; }
.chatrow input { flex: 1; padding: 8px 10px; border: 1px solid #c9cdd4; border-radius: 8px; font: inherit; background: transparent; color: inherit; }
.chatrow input:disabled { opacity: .5; }
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

type Exchange = { el: HTMLElement; markdown: string; queued: boolean }

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
      <div class="chatslot"></div>
      <div class="sources"></div>
      <div class="foot">
        <span class="meta"></span>
        <span class="actions"></span>
      </div>
    </div>`
  root.append(style, card)

  const body = card.querySelector('.body') as HTMLElement
  const chatSlot = card.querySelector('.chatslot') as HTMLElement
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

  let citations = new Map<number, string>()
  let current: Exchange | null = null
  let chatInput: HTMLInputElement | null = null
  let chatHandler: ((q: string) => void) | null = null

  const button = (label: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.className = 'wc'
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  const shimmer = (message: string) => {
    const p = document.createElement('p')
    p.className = 'shimmer'
    p.textContent = message
    return p
  }

  const newExchange = (loadingMessage: string): Exchange => {
    const el = document.createElement('div')
    el.className = 'exchange'
    el.append(shimmer(loadingMessage))
    body.append(el)
    current = { el, markdown: '', queued: false }
    return current
  }

  const renderExchange = (ex: Exchange) => {
    ex.queued = false
    ex.el.innerHTML = renderMarkdown(ex.markdown, citations)
  }
  const scheduleRender = (ex: Exchange) => {
    if (ex.queued) return
    ex.queued = true
    requestAnimationFrame(() => renderExchange(ex))
  }

  const setChatDisabled = (disabled: boolean) => {
    if (chatInput) chatInput.disabled = disabled
  }

  const resetAll = () => {
    body.replaceChildren()
    sourcesEl.replaceChildren()
    actionsEl.replaceChildren()
    chatSlot.replaceChildren()
    chatInput = null
    chatHandler = null
    current = null
    citations = new Map()
  }

  return {
    setSetup() {
      body.innerHTML = '<p><strong>Webcrawla isn’t configured yet.</strong> Add your endpoint, API key and model to get AI overviews here.</p>'
      actionsEl.replaceChildren(button('Open settings', () => {
        chrome.runtime.sendMessage({ target: 'background', kind: 'open-options' })
      }))
    },
    setIdle(onRun) {
      body.replaceChildren(button('✨ Summarize these results', onRun))
      actionsEl.replaceChildren()
    },
    setLoading(message) {
      if (!current) {
        // First loading call of a fresh card (summary path): start clean.
        body.replaceChildren()
        newExchange(message)
      } else if (current.markdown === '') {
        current.el.replaceChildren(shimmer(message))
      }
      actionsEl.replaceChildren()
      setChatDisabled(true)
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
      if (!current) newExchange('')
      if (current!.markdown === '') current!.el.replaceChildren() // clear shimmer on first token
      current!.markdown += text
      scheduleRender(current!)
    },
    finish(onRerun) {
      if (current) renderExchange(current)
      actionsEl.replaceChildren()
      if (onRerun) {
        actionsEl.append(button('↻ Regenerate', () => {
          resetAll()
          onRerun()
        }))
      }
      setChatDisabled(false)
    },
    setError(message, onRetry) {
      const ex = current ?? newExchange('')
      const p = document.createElement('p')
      p.className = 'err'
      p.textContent = message
      const retry = button('Retry', () => {
        ex.el.remove()
        if (current === ex) current = null
        onRetry()
      })
      ex.el.replaceChildren(p, retry)
      ex.markdown = ''
      actionsEl.replaceChildren()
      setChatDisabled(false)
    },
    addUserMessage(text) {
      const q = document.createElement('div')
      q.className = 'user-q'
      q.textContent = text
      body.append(q)
    },
    beginExchange() {
      newExchange('Thinking…')
      setChatDisabled(true)
    },
    enableChat(onAsk) {
      chatHandler = onAsk
      if (chatInput) return // row already exists; handler updated above
      const row = document.createElement('div')
      row.className = 'chatrow'
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = 'Ask a follow-up…'
      const submit = () => {
        const q = input.value.trim()
        if (!q || input.disabled || !chatHandler) return
        input.value = ''
        chatHandler(q)
      }
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') submit()
      })
      const ask = button('Ask', submit)
      row.append(input, ask)
      chatSlot.replaceChildren(row)
      chatInput = input
    },
    restore(display, sources) {
      body.replaceChildren()
      current = null
      this.setSources(sources)
      for (const msg of display) {
        if (msg.role === 'user') {
          this.addUserMessage(msg.markdown)
        } else {
          const el = document.createElement('div')
          el.className = 'exchange'
          el.innerHTML = renderMarkdown(msg.markdown, citations)
          body.append(el)
        }
      }
    },
  }
}
```

- [ ] **Step 2: Update existing panel tests and add new failing tests**

Existing `tests/panel.test.ts` behavioral tests must keep proving: (a) error → retry → clean rerun with no stale text; (b) `finish(onRerun)` regenerate resets; (c) `finish()` with no arg shows no button. Update selectors/assertions only where the DOM now nests answers in `.exchange` divs (e.g. query the shadow root's `.body` textContent as before — most assertions should survive unchanged; the retry button now lives inside the exchange block instead of `.actions`).

Add:
```ts
  it('enableChat renders an input and submits questions', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    const asked: string[] = []
    panel.enableChat(q => asked.push(q))
    const input = host.shadowRoot!.querySelector('.chatrow input') as HTMLInputElement
    input.value = '  why though?  '
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(asked).toEqual(['why though?'])
    expect(input.value).toBe('')
  })

  it('follow-up exchanges render independently of the summary', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    panel.setLoading('Reading…')
    panel.appendToken('SUMMARY')
    panel.finish()
    panel.addUserMessage('why?')
    panel.beginExchange()
    panel.appendToken('FOLLOWUP')
    panel.finish()
    const blocks = host.shadowRoot!.querySelectorAll('.body .exchange')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].textContent).toBe('SUMMARY')
    expect(blocks[1].textContent).toBe('FOLLOWUP')
    expect(host.shadowRoot!.querySelector('.user-q')!.textContent).toBe('why?')
  })

  it('chat input disables during a follow-up stream and re-enables on finish', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    panel.enableChat(() => {})
    const input = host.shadowRoot!.querySelector('.chatrow input') as HTMLInputElement
    panel.beginExchange()
    expect(input.disabled).toBe(true)
    panel.appendToken('x')
    panel.finish()
    expect(input.disabled).toBe(false)
  })

  it('a follow-up error offers retry inside its exchange and removes the block on retry', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    panel.setLoading('Reading…')
    panel.appendToken('SUMMARY')
    panel.finish()
    panel.addUserMessage('why?')
    panel.beginExchange()
    let retried = false
    panel.setError('boom', () => { retried = true })
    const blocks = host.shadowRoot!.querySelectorAll('.body .exchange')
    expect(blocks).toHaveLength(2)
    const retryBtn = blocks[1].querySelector('button') as HTMLButtonElement
    retryBtn.click()
    expect(retried).toBe(true)
    expect(host.shadowRoot!.querySelectorAll('.body .exchange')).toHaveLength(1)
    expect(host.shadowRoot!.querySelector('.body')!.textContent).toContain('SUMMARY')
  })

  it('restore renders a display transcript with working citations', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    panel.restore(
      [
        { role: 'assistant', markdown: 'Summary [1].' },
        { role: 'user', markdown: 'why?' },
        { role: 'assistant', markdown: 'Because [1].' },
      ],
      [{ index: 1, url: 'https://a.com', title: 'A', ok: true }],
    )
    const rootEl = host.shadowRoot!
    expect(rootEl.querySelectorAll('.body .exchange')).toHaveLength(2)
    expect(rootEl.querySelector('.user-q')!.textContent).toBe('why?')
    expect(rootEl.querySelectorAll('sup.cite a')).toHaveLength(2)
    expect(rootEl.querySelectorAll('.sources a')).toHaveLength(1)
  })
```

- [ ] **Step 3: Run to verify new tests fail, then implement/adjust until green**

Run: `npx vitest run tests/panel.test.ts` — Expected first: FAIL (missing methods); after implementation: 8 passed (3 updated + 5 new)

- [ ] **Step 4: Full suite, typecheck, build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 88 tests, all green.

- [ ] **Step 5: Commit**

```bash
git add src/content/panel.ts tests/panel.test.ts
git commit -m "feat: per-exchange panel rendering with inline follow-up chat"
```

---

### Task 6: Content script wiring — jobId, restore, follow-ups

**Files:**
- Modify: `src/content/index.ts` (full replacement below)

**Interfaces:**
- Consumes: Panel API (Task 5), protocol (Task 1), background handlers (Task 4).

- [ ] **Step 1: Replace `src/content/index.ts`**

```ts
import type { DisplayMessage, SourceInfo, StreamEvent } from '../shared/types'
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

type JobCtx = {
  jobId: string
  query: string
  results: ReturnType<typeof scrapeSerp>
  panel: Panel
}

function wirePort(
  request: object,
  panel: Panel,
  handlers: { onDone: () => void; onRetry: () => void },
) {
  const port = chrome.runtime.connect({ name: 'webcrawla' })
  port.postMessage(request)
  let settled = false
  port.onMessage.addListener((e: StreamEvent) => {
    switch (e.type) {
      case 'status': panel.setLoading(e.message); break
      case 'sources': panel.setSources(e.sources); break
      case 'token': panel.appendToken(e.text); break
      case 'done': settled = true; handlers.onDone(); port.disconnect(); break
      case 'error': settled = true; panel.setError(e.message, handlers.onRetry); port.disconnect(); break
    }
  })
  port.onDisconnect.addListener(() => {
    if (!settled) panel.setError('Connection to the extension was lost.', handlers.onRetry)
  })
}

function startJob(ctx: JobCtx) {
  ctx.panel.setLoading('Reading sources…')
  wirePort({ type: 'run', jobId: ctx.jobId, query: ctx.query, results: ctx.results }, ctx.panel, {
    onDone: () => {
      ctx.panel.finish(() => regenerate(ctx))
      ctx.panel.enableChat(q => startFollowup(ctx, q))
    },
    onRetry: () => startJob(ctx),
  })
}

function startFollowup(ctx: JobCtx, question: string, isRetry = false) {
  if (!isRetry) ctx.panel.addUserMessage(question)
  ctx.panel.beginExchange()
  wirePort({ type: 'followup', jobId: ctx.jobId, question }, ctx.panel, {
    onDone: () => ctx.panel.finish(() => regenerate(ctx)),
    onRetry: () => startFollowup(ctx, question, true),
  })
}

function regenerate(ctx: JobCtx) {
  // Fresh jobId: the old conversation is abandoned; its query-index entry is
  // overwritten when the new run saves, and the record ages out via pruning.
  ctx.jobId = crypto.randomUUID()
  startJob(ctx)
}

type RestoredConversation = { jobId: string; display: DisplayMessage[]; sources: SourceInfo[] }

async function findRestorable(query: string): Promise<RestoredConversation | null> {
  try {
    return (await chrome.runtime.sendMessage({ target: 'background', kind: 'get-conversation', query })) ?? null
  } catch {
    return null
  }
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

  const ctx: JobCtx = { jobId: crypto.randomUUID(), query, results, panel }

  const restored = await findRestorable(query)
  if (restored) {
    ctx.jobId = restored.jobId
    panel.restore(restored.display, restored.sources)
    panel.finish(() => regenerate(ctx)) // no active exchange: just Regenerate + chat re-enable
    panel.enableChat(q => startFollowup(ctx, q))
    return
  }

  const run = () => startJob(ctx)
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

- [ ] **Step 2: Verify build, typecheck, full suite**

Run: `npm run build && npm run typecheck && npm test`
Expected: all green (88 tests).

- [ ] **Step 3: Commit**

```bash
git add src/content/index.ts
git commit -m "feat: content wiring for follow-up chat and conversation restore"
```

---

### Task 7: E2E verification, version bump, README

**Files:**
- Modify: `src/manifest.json` (version → `0.2.0`), `package.json` (version → `0.2.0`), `README.md` (follow-up chat section)

Manual verification with the user in the loop (live Vivaldi + Ollama Cloud key):

- [ ] **Step 1:** Bump both versions to `0.2.0`; add a README section under the feature list: follow-up chat with tool access, session-scoped conversation restore (until browser close, last 5 conversations), Regenerate starts fresh.
- [ ] **Step 2:** `npm run build`; user reloads the extension.
- [ ] **Step 3:** User verifies: (a) summary → "Ask a follow-up" input appears; (b) a follow-up needing no crawl streams quickly with citations; (c) a follow-up needing new info grows the source strip with continued indices; (d) reload the results page → summary + chat restore without re-running; (e) Regenerate clears chat and reruns; (f) follow-up error (e.g. briefly wrong API key) shows retry inside the chat.
- [ ] **Step 4:** Commit + merge per finishing-a-development-branch; push to GitHub.

```bash
git add src/manifest.json package.json README.md
git commit -m "chore: v0.2.0 — follow-up chat"
```

---

## Self-Review Notes

- **Spec coverage:** UX items 1-8 → Tasks 5/6 (chat input, quoted questions, streamed replies, growing sources, disabled input, Regenerate reset, restore, error/expired handling); storage & eviction → Task 1; protocol → Task 1; `executeExchange`/`runFollowup`/caps-per-exchange → Tasks 2-3; routing + `get-conversation` → Task 4; save-failure tolerance → Tasks 2-3 tests; out-of-scope items absent.
- **Type consistency:** `TranscriptStore`/`ConversationRecord`/`DisplayMessage`/`JobRequest` names and shapes match across Tasks 1-6; Panel method names in Task 6 match Task 5's interface; `runAgent(jobId, query, ...)` arity matches Tasks 2/4.
- **Known judgment calls:** follow-up retry reuses the same question without re-adding the bubble (`isRetry`); an errored follow-up never saves, so the transcript stays clean for retry; `get-conversation` strips source text to keep the message small.
