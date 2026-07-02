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
