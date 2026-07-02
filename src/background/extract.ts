let creating: Promise<void> | null = null

export async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: 'Extract readable text from fetched result pages',
      })
      .finally(() => { creating = null })
  }
  await creating
}

export async function extractInOffscreen(
  html: string,
  url: string,
  charBudget: number,
): Promise<{ title: string; text: string }> {
  await ensureOffscreen()
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', kind: 'extract', html, url, charBudget })
  if (!res?.ok) throw new Error(res?.error ?? 'extraction failed')
  return { title: res.title, text: res.text }
}
