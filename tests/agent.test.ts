import { describe, expect, it, vi } from 'vitest'
import { runAgent, runFollowup, type AgentDeps } from '../src/background/agent'
import { DEFAULT_SETTINGS, type SerpResult, type StreamEvent } from '../src/shared/types'
import type { streamChat, TurnResult } from '../src/background/llm'

const fakeTranscripts = () => ({
  load: vi.fn(async () => null),
  save: vi.fn(async () => {}),
})

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

function depsWith(chat: typeof streamChat): AgentDeps {
  return {
    fetchAndExtract: vi.fn(okExtract),
    streamChat: chat,
    transcripts: fakeTranscripts(),
    searchWeb: vi.fn(async () => []),
  }
}

describe('runAgent', () => {
  it('prefetches, emits sources, streams tokens, emits done', async () => {
    const { events, emit } = collect()
    const transcripts = fakeTranscripts()
    const deps: AgentDeps = {
      fetchAndExtract: vi.fn(okExtract),
      streamChat: chatReturning({ content: 'Answer [1].', toolCalls: [], finishReason: 'stop' }),
      transcripts,
      searchWeb: vi.fn(async () => []),
    }
    await runAgent('job-1', 'how do heat pumps work', results, settings, deps, emit)
    expect(deps.fetchAndExtract).toHaveBeenCalledTimes(2) // maxPrefetch
    const sources = events.find(e => e.type === 'sources')
    expect(sources && sources.type === 'sources' && sources.sources).toHaveLength(2)
    expect(events.filter(e => e.type === 'token').map(e => (e as any).text).join('')).toBe('Answer [1].')
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('executes tool calls and feeds results back', async () => {
    const { events, emit } = collect()
    const transcripts = fakeTranscripts()
    const chat = chatReturning(
      {
        content: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://c.com"}' } }],
        finishReason: 'tool_calls',
      },
      { content: 'Deeper answer [3].', toolCalls: [], finishReason: 'stop' },
    )
    const deps: AgentDeps = { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }
    await runAgent('job-1', 'q about things', results, settings, deps, emit)
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
    const transcripts = fakeTranscripts()
    const toolTurn: TurnResult = {
      content: '',
      toolCalls: [{ id: 'x', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://c.com"}' } }],
      finishReason: 'tool_calls',
    }
    const chat = chatReturning(toolTurn, toolTurn, toolTurn, toolTurn, toolTurn)
    await runAgent('job-1', 'q', results, settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit)
    expect(chat).toHaveBeenCalledTimes(4) // initial + 3 tool rounds
  })

  it('falls back to snippets when nothing extracts', async () => {
    const { emit } = collect()
    const transcripts = fakeTranscripts()
    const chat = chatReturning({ content: 'ok', toolCalls: [], finishReason: 'stop' })
    await runAgent('job-1', 'q', results, settings, { fetchAndExtract: vi.fn(async () => null), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit)
    const messages = (chat as any).mock.calls[0][0].messages
    expect(messages[1].content).toContain('snip a')
  })

  it('emits error event when the LLM call throws', async () => {
    const { events, emit } = collect()
    const transcripts = fakeTranscripts()
    const chat = vi.fn(async () => { throw new Error('boom 401') }) as unknown as typeof streamChat
    await runAgent('job-1', 'q', results, settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit)
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('boom 401') })
  })

  it('forces an answer on the final round by omitting tools', async () => {
    const { events, emit } = collect()
    const transcripts = fakeTranscripts()
    let toolCallCount = 0
    const chat = vi.fn(async (opts: Parameters<typeof streamChat>[0]) => {
      if (opts.tools && (opts.tools as unknown[]).length) {
        toolCallCount++
        const turn: TurnResult = {
          content: '',
          toolCalls: [{ id: `t${toolCallCount}`, type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://c.com"}' } }],
          finishReason: 'tool_calls',
        }
        return turn
      }
      const turn: TurnResult = { content: 'Final answer.', toolCalls: [], finishReason: 'stop' }
      for (const ch of turn.content) opts.onToken?.(ch)
      return turn
    }) as unknown as typeof streamChat
    const deps: AgentDeps = { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }
    await runAgent('job-1', 'q about things', results, settings, deps, emit)
    expect(chat).toHaveBeenCalledTimes(4)
    const calls = (chat as any).mock.calls
    expect(calls[3][0].tools).toBeUndefined()
    const tokens = events.filter(e => e.type === 'token').map(e => (e as any).text).join('')
    expect(tokens).toContain('Final answer.')
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('emits a timeout error when fetchAndExtract hangs past the time budget', async () => {
    vi.useFakeTimers()
    try {
      const { events, emit } = collect()
      const transcripts = fakeTranscripts()
      const deps: AgentDeps = {
        fetchAndExtract: vi.fn(() => new Promise(() => {})),
        streamChat: chatReturning({ content: 'unused', toolCalls: [], finishReason: 'stop' }),
        transcripts,
        searchWeb: vi.fn(async () => []),
      }
      const promise = runAgent('job-1', 'q', results, settings, deps, emit)
      await vi.advanceTimersByTimeAsync(45_000)
      await promise
      expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/time|budget/i) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects unknown tool calls without fetching', async () => {
    const { emit } = collect()
    const transcripts = fakeTranscripts()
    const chat = chatReturning(
      {
        content: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'evil_tool', arguments: '{"url":"https://c.com"}' } }],
        finishReason: 'tool_calls',
      },
      { content: 'Answer.', toolCalls: [], finishReason: 'stop' },
    )
    const fetchAndExtract = vi.fn(okExtract)
    await runAgent('job-1', 'q', results, settings, { fetchAndExtract, streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit)
    expect(fetchAndExtract).toHaveBeenCalledTimes(2) // only the two prefetch calls, no tool fetch
    const calls = (chat as any).mock.calls
    const secondMessages = calls[1][0].messages
    const toolMsg = secondMessages.find((m: any) => m.role === 'tool' && m.tool_call_id === 't1')
    expect(toolMsg.content).toBe('Error: unknown tool.')
  })

  it('dedupes fetch_page calls for an already-fetched URL', async () => {
    const { emit } = collect()
    const transcripts = fakeTranscripts()
    const chat = chatReturning(
      {
        content: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://a.com"}' } }],
        finishReason: 'tool_calls',
      },
      { content: 'Answer.', toolCalls: [], finishReason: 'stop' },
    )
    const fetchAndExtract = vi.fn(okExtract)
    await runAgent('job-1', 'q', results, settings, { fetchAndExtract, streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit)
    expect(fetchAndExtract).toHaveBeenCalledTimes(2) // a.com already fetched during prefetch
    const calls = (chat as any).mock.calls
    const secondMessages = calls[1][0].messages
    const toolMsg = secondMessages.find((m: any) => m.role === 'tool' && m.tool_call_id === 't1')
    expect(toolMsg.content).toContain('Already fetched')
  })

  it('saves the conversation transcript on success', async () => {
    const { emit } = collect()
    const transcripts = { load: vi.fn(async () => null), save: vi.fn(async () => {}) }
    const deps: AgentDeps = {
      fetchAndExtract: vi.fn(okExtract),
      streamChat: chatReturning({ content: 'Answer [1].', toolCalls: [], finishReason: 'stop' }),
      transcripts,
      searchWeb: vi.fn(async () => []),
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
    await runAgent('job-1', 'q', results, settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit)
    expect(transcripts.save).not.toHaveBeenCalled()
  })

  it('a failing save is non-fatal (done already emitted, no throw)', async () => {
    const { events, emit } = collect()
    const transcripts = { load: vi.fn(async () => null), save: vi.fn(async () => { throw new Error('quota') }) }
    const deps: AgentDeps = {
      fetchAndExtract: vi.fn(okExtract),
      streamChat: chatReturning({ content: 'ok', toolCalls: [], finishReason: 'stop' }),
      transcripts,
      searchWeb: vi.fn(async () => []),
    }
    await expect(runAgent('job-1', 'q', results, settings, deps, emit)).resolves.toBeUndefined()
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('does not duplicate round content in the persisted transcript', async () => {
    const { events, emit } = collect()
    const transcripts = fakeTranscripts()
    const chat = chatReturning(
      {
        content: 'Checking sources. ',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://c.com"}' } }],
        finishReason: 'tool_calls',
      },
      { content: 'Final answer.', toolCalls: [], finishReason: 'stop' },
    )
    const deps: AgentDeps = { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }
    await runAgent('job-1', 'q about things', results, settings, deps, emit)

    const rec = (transcripts.save as any).mock.calls[0][0]
    expect(rec.messages.at(-1)).toEqual({ role: 'assistant', content: 'Final answer.' })
    expect(rec.messages.at(-1).content).not.toContain('Checking sources.')
    const toolCallMsg = rec.messages.find((m: any) => m.role === 'assistant' && m.tool_calls)
    expect(toolCallMsg.content).toBe('Checking sources. ')
    expect(rec.display).toEqual([{ role: 'assistant', markdown: 'Checking sources. Final answer.' }])
    const tokens = events.filter(e => e.type === 'token').map(e => (e as any).text).join('')
    expect(tokens).toBe('Checking sources. Final answer.')
  })

  it('trims an incomplete tool round from persisted messages when the time budget aborts mid-round', async () => {
    vi.useFakeTimers()
    try {
      const { events, emit } = collect()
      const transcripts = fakeTranscripts()
      const chat = vi.fn(async (opts: Parameters<typeof streamChat>[0]) => {
        for (const ch of 'Part ') opts.onToken?.(ch)
        const turn: TurnResult = {
          content: 'Part ',
          toolCalls: [
            { id: 't1', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://c.com"}' } },
            { id: 't2', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://d.com"}' } },
          ],
          finishReason: 'tool_calls',
        }
        return turn
      }) as unknown as typeof streamChat
      const fetchAndExtract = vi.fn(async (url: string, charBudget: number) => {
        if (url === 'https://c.com' || url === 'https://d.com') return new Promise<never>(() => {})
        return okExtract(url)
      })
      const deps: AgentDeps = { fetchAndExtract: fetchAndExtract as any, streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }
      const promise = runAgent('job-1', 'q about things', results, settings, deps, emit)
      await vi.advanceTimersByTimeAsync(45_000)
      await promise

      expect(events.at(-1)).toEqual({ type: 'done' })
      expect(transcripts.save).toHaveBeenCalledTimes(1)
      const rec = (transcripts.save as any).mock.calls[0][0]
      const incompleteToolCallMsgs = rec.messages.filter((m: any, i: number) => {
        if (m.role !== 'assistant' || !m.tool_calls?.length) return false
        const following = rec.messages.slice(i + 1).filter((mm: any) => mm.role === 'tool')
        return following.length < m.tool_calls.length
      })
      expect(incompleteToolCallMsgs).toHaveLength(0)
      expect(rec.messages.at(-1)).toEqual({ role: 'assistant', content: expect.stringContaining('Part') })
    } finally {
      vi.useRealTimers()
    }
  })
})

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
    await runFollowup('gone', 'why?', settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit)
    expect(events).toEqual([{ type: 'error', message: 'Conversation expired — regenerate to start fresh.' }])
    expect(chat).not.toHaveBeenCalled()
  })

  it('appends the question, streams the answer, and saves the grown transcript', async () => {
    const { events, emit } = collect()
    const transcripts = { load: vi.fn(async () => baseRecord()), save: vi.fn(async () => {}) }
    const chat = chatReturning({ content: 'Because physics [2].', toolCalls: [], finishReason: 'stop' })
    await runFollowup('job-1', 'why is it efficient?', settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit)

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
    await runFollowup('job-1', 'what about costs?', settings, { fetchAndExtract, streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit)
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
    await runFollowup('job-1', 'q2', settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit)
    expect(transcripts.save).not.toHaveBeenCalled()
  })

  it('a failing save is non-fatal', async () => {
    const { events, emit } = collect()
    const transcripts = { load: vi.fn(async () => baseRecord()), save: vi.fn(async () => { throw new Error('quota') }) }
    const chat = chatReturning({ content: 'ok', toolCalls: [], finishReason: 'stop' })
    await expect(
      runFollowup('job-1', 'q2', settings, { fetchAndExtract: vi.fn(okExtract), streamChat: chat, transcripts, searchWeb: vi.fn(async () => []) }, emit),
    ).resolves.toBeUndefined()
    expect(events.at(-1)).toEqual({ type: 'done' })
  })
})

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
