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
