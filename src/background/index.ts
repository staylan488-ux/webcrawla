import type { JobRequest, StreamEvent } from '../shared/types'
import { loadSettings } from '../shared/settings'
import { runAgent, runFollowup, type AgentDeps } from './agent'
import { extractInOffscreen } from './extract'
import { fetchPage } from './fetcher'
import { streamChat } from './llm'
import { searchWeb } from './search'
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
  searchWeb: async () => [],
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
    const jobDeps: AgentDeps = { ...deps, searchWeb: (q: string) => searchWeb(q, settings) }
    const keepalive = setInterval(() => { void chrome.storage.local.get('keepalive') }, 20_000)
    try {
      if (msg.type === 'run') {
        await runAgent(msg.jobId, msg.query, msg.results, settings, jobDeps, emit)
      } else {
        await runFollowup(msg.jobId, msg.question, settings, jobDeps, emit)
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
    void findConversationByQuery(msg.query)
      .then(rec => {
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
      .catch(() => sendResponse(null))
    return true // async sendResponse
  }
})
