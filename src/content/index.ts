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
