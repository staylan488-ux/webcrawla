import type { ExtractedSource, SerpResult, Settings, StreamEvent } from '../shared/types'
import type { ChatMessage, streamChat as streamChatFn } from './llm'
import { FETCH_PAGE_TOOL, WEB_SEARCH_TOOL, buildSystemPrompt, buildUserMessage } from './prompt'
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
  searchWeb: (query: string) => Promise<SerpResult[]>
}

const MAX_TOOL_ROUNDS = 3
const MAX_TOTAL_PAGES = 8
const MAX_SEARCHES = 2
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

function parseQueryArg(raw: string): string | null {
  try {
    const q = JSON.parse(raw)?.query
    return typeof q === 'string' && q.trim() ? q.trim() : null
  } catch {
    return null
  }
}

type Race = <T>(p: Promise<T>) => Promise<T>

// Finds the last assistant message carrying tool_calls and, if it isn't
// followed by a matching tool response for every call, splices it (and
// everything after it) off the end of `messages`. Only the terminal round of
// an exchange can ever be incomplete — every earlier round fully resolves
// its tool responses before the next streamChat call is made — so this only
// ever needs to look at the tail of the array.
function trimIncompleteToolRound(messages: ChatMessage[]): void {
  let idx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.tool_calls?.length) {
      idx = i
      break
    }
  }
  if (idx === -1) return
  const expected = messages[idx].tool_calls!.length
  const following = messages.slice(idx + 1).filter(m => m.role === 'tool').length
  if (following < expected) messages.splice(idx)
}

// One complete model exchange: optional preparation (prefetch) inside the time
// budget, then the capped streaming tool loop. Owns the 45s budget, token
// bookkeeping, and the done/error emission semantics. Returns `ok` (whether
// the exchange ended with a `done` event), `answer` (the full streamed text
// across every round, for the panel's display markdown), and `finalText`
// (the text to persist as the terminal assistant message — the terminal
// round's text alone on normal completion, since intermediate rounds'
// narration is already captured in their own tool_calls messages; the full
// streamed `answer` on a mid-round abort, since the terminal round never
// completed).
async function executeExchange(opts: {
  messages: ChatMessage[]
  sources: ExtractedSource[]
  settings: Settings
  deps: AgentDeps
  emit: Emit
  // Runs inside the budget before the loop; returns pages already consumed
  // this exchange (the prefetch count for summaries; omit for follow-ups).
  prepare?: (race: Race) => Promise<number>
}): Promise<{ ok: boolean; answer: string; finalText: string }> {
  const { messages, sources, settings, deps, emit } = opts
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), OVERALL_BUDGET_MS)
  let tokensEmitted = false
  let answer = ''
  let roundText = ''

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
    let searchesUsed = 0
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // Only offer the tool while rounds remain; the final round is answer-only so
      // the model can't dead-end on a tool call that streams no content.
      const offerTools = round < MAX_TOOL_ROUNDS
      roundText = ''
      const turn = await deps.streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages,
        ...(offerTools ? { tools: [FETCH_PAGE_TOOL, WEB_SEARCH_TOOL] } : {}),
        signal: abort.signal,
        onToken: t => {
          tokensEmitted = true
          answer += t
          roundText += t
          emit({ type: 'token', text: t })
        },
      })
      if (!turn.toolCalls.length || round === MAX_TOOL_ROUNDS) break

      messages.push({ role: 'assistant', content: turn.content || null, tool_calls: turn.toolCalls })
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
    return { ok: true, answer, finalText: roundText || answer }
  } catch (err) {
    if (abort.signal.aborted) {
      // Time budget exhausted: per spec, abort remaining work and finish with
      // whatever streamed rather than dropping the user's partial answer. The
      // terminal round never completed, so the full streamed answer (not just
      // roundText) is what we have to persist as the final assistant turn.
      if (tokensEmitted) {
        emit({ type: 'done' })
        return { ok: true, answer, finalText: answer }
      }
      emit({ type: 'error', message: 'Time budget exceeded before a response could be produced.' })
    } else {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
    return { ok: false, answer, finalText: answer }
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

  const { ok, answer, finalText } = await executeExchange({
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
    // Guard against an abort that landed mid tool-round: an assistant
    // tool_calls message without a full set of following tool responses is
    // not valid to replay through an OpenAI-compatible API.
    trimIncompleteToolRound(messages)
    messages.push({ role: 'assistant', content: finalText })
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
  const { ok, answer, finalText } = await executeExchange({
    messages: rec.messages,
    sources: rec.sources,
    settings,
    deps,
    emit,
  })

  if (ok && answer) {
    trimIncompleteToolRound(rec.messages)
    // Reassign rather than mutate in place: the array object was handed to
    // deps.streamChat by reference, and a test inspects that call's captured
    // `messages` argument after this function returns — mutating the same
    // array in place would retroactively "rewrite" what was sent.
    rec.messages = [...rec.messages, { role: 'assistant', content: finalText }]
    rec.display.push({ role: 'user', markdown: question }, { role: 'assistant', markdown: answer })
    rec.updatedAt = Date.now()
    try {
      await deps.transcripts.save(rec)
    } catch {
      // Non-fatal per spec.
    }
  }
}
