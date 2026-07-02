import { extractReadable } from './extract-core'
import { parseDdgSerp } from './serp-parse-core'

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return
  if (msg.kind === 'extract') {
    try {
      sendResponse({ ok: true, ...extractReadable(msg.html, msg.url, msg.charBudget) })
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (msg.kind === 'parse-serp') {
    try {
      sendResponse({ ok: true, results: parseDdgSerp(msg.html) })
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
})
