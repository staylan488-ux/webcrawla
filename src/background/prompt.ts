import type { ExtractedSource } from '../shared/types'

export const FETCH_PAGE_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_page',
    description:
      'Fetch a web page and return its readable text content. Use when the provided sources are insufficient — e.g. to read another search result or follow a link mentioned in a source.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL of the page to fetch' },
      },
      required: ['url'],
    },
  },
} as const

export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web for pages relevant to a query. Use when the provided sources cannot answer the question — especially follow-up questions about new aspects — then fetch_page the promising results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
} as const

const SYSTEM_PROMPT = `You are an AI search assistant that writes a grounded overview answering the user's search query, in the style of a search engine AI overview.

Rules:
- Base your answer ONLY on the numbered sources provided. Cite claims inline with bracketed source numbers like [1] or [2][3].
- Be concise: 120-250 words. Use markdown. Prefer a short direct answer first, then supporting detail. Use a bullet list only when it genuinely helps.
- If the sources do not contain enough information to answer, say so plainly rather than guessing.
- You may call web_search to find pages when the question needs information beyond the provided sources — especially follow-up questions about new aspects — and fetch_page to read search results or links referenced in a source. Prefer searching and reading over telling the user to look elsewhere. Do not call tools when you already have enough.
- Never invent citations or URLs. Only cite source numbers that exist.`

export function buildSystemPrompt(override?: string): string {
  return override?.trim() ? override : SYSTEM_PROMPT
}

export function formatSource(s: ExtractedSource): string {
  const header = `[${s.index}] ${s.title} — ${s.url}`
  const body = s.ok && s.text ? s.text : '(content unavailable)'
  return `${header}\n${body}`
}

export function buildUserMessage(query: string, sources: ExtractedSource[]): string {
  const sourceBlock = sources.map(formatSource).join('\n\n')
  return `Search query: ${query}\n\nSources:\n\n${sourceBlock}`
}
