import { Readability } from '@mozilla/readability'

export function extractReadable(
  html: string,
  url: string,
  charBudget: number,
): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const base = doc.createElement('base')
  base.href = url
  doc.head.appendChild(base)
  let article: { title?: string | null; textContent?: string | null } | null = null
  try {
    article = new Readability(doc, { charThreshold: 250 }).parse()
  } catch {
    article = null
  }
  const title = (article?.title || doc.title || url).trim()
  let text = (article?.textContent || doc.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > charBudget) text = text.slice(0, charBudget) + '…'
  return { title, text }
}
