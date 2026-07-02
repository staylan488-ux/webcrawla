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

afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it('releases reader lock and propagates stream errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode(chunk({ choices: [{ delta: { content: 'Hel' } }] })))
          controller.error(new Error('network drop'))
        },
      })
      return new Response(stream, { status: 200 })
    }))
    await expect(
      streamChat({
        baseUrl: 'https://ollama.com/v1', apiKey: 'k', model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('network drop')
  })
})
