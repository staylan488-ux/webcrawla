import type { JobRequest, StreamEvent } from '../shared/types'
import { loadSettings } from '../shared/settings'
import { runAgent, type AgentDeps } from './agent'
import { extractInOffscreen } from './extract'
import { fetchPage } from './fetcher'
import { streamChat } from './llm'

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
    if (msg?.type !== 'run') return
    const settings = await loadSettings()
    if (!settings.apiKey || !settings.model) {
      emit({ type: 'error', message: 'Not configured — set your endpoint, API key and model in Webcrawla options.' })
      return
    }
    const keepalive = setInterval(() => { void chrome.storage.local.get('keepalive') }, 20_000)
    try {
      await runAgent(msg.query, msg.results, settings, deps, emit)
    } finally {
      clearInterval(keepalive)
    }
  })
})

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.target === 'background' && msg.kind === 'open-options') {
    void chrome.runtime.openOptionsPage()
  }
})
