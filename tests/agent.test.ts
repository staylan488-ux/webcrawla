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

  it('forces an answer on the final round by omitting tools', async () => {
    const { events, emit } = collect()
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
    const deps: AgentDeps = { fetchAndExtract: vi.fn(okExtract), streamChat: chat }
    await runAgent('q about things', results, settings, deps, emit)
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
      const deps: AgentDeps = {
        fetchAndExtract: vi.fn(() => new Promise(() => {})),
        streamChat: chatReturning({ content: 'unused', toolCalls: [], finishReason: 'stop' }),
      }
      const promise = runAgent('q', results, settings, deps, emit)
      await vi.advanceTimersByTimeAsync(45_000)
      await promise
      expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/time|budget/i) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects unknown tool calls without fetching', async () => {
    const { emit } = collect()
    const chat = chatReturning(
      {
        content: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'evil_tool', arguments: '{"url":"https://c.com"}' } }],
        finishReason: 'tool_calls',
      },
      { content: 'Answer.', toolCalls: [], finishReason: 'stop' },
    )
    const fetchAndExtract = vi.fn(okExtract)
    await runAgent('q', results, settings, { fetchAndExtract, streamChat: chat }, emit)
    expect(fetchAndExtract).toHaveBeenCalledTimes(2) // only the two prefetch calls, no tool fetch
    const calls = (chat as any).mock.calls
    const secondMessages = calls[1][0].messages
    const toolMsg = secondMessages.find((m: any) => m.role === 'tool' && m.tool_call_id === 't1')
    expect(toolMsg.content).toBe('Error: unknown tool.')
  })

  it('dedupes fetch_page calls for an already-fetched URL', async () => {
    const { emit } = collect()
    const chat = chatReturning(
      {
        content: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://a.com"}' } }],
        finishReason: 'tool_calls',
      },
      { content: 'Answer.', toolCalls: [], finishReason: 'stop' },
    )
    const fetchAndExtract = vi.fn(okExtract)
    await runAgent('q', results, settings, { fetchAndExtract, streamChat: chat }, emit)
    expect(fetchAndExtract).toHaveBeenCalledTimes(2) // a.com already fetched during prefetch
    const calls = (chat as any).mock.calls
    const secondMessages = calls[1][0].messages
    const toolMsg = secondMessages.find((m: any) => m.role === 'tool' && m.tool_call_id === 't1')
    expect(toolMsg.content).toContain('Already fetched')
  })
})
