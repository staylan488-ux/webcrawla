import type { DisplayMessage, JobRequest, SourceInfo, StreamEvent } from '../shared/types'
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
  request: JobRequest,
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
