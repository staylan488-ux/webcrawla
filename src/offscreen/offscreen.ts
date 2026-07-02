import { extractReadable } from './extract-core'

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.kind !== 'extract') return
  try {
    sendResponse({ ok: true, ...extractReadable(msg.html, msg.url, msg.charBudget) })
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
