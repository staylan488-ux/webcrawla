export type SerpResult = { title: string; url: string; snippet: string }

export type SourceInfo = { index: number; url: string; title: string; ok: boolean }

export type ExtractedSource = SourceInfo & { text: string }

export type StreamEvent =
  | { type: 'status'; message: string }
  | { type: 'sources'; sources: SourceInfo[] }
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type JobRequest =
  | { type: 'run'; jobId: string; query: string; results: SerpResult[] }
  | { type: 'followup'; jobId: string; question: string }

export type DisplayMessage = { role: 'user' | 'assistant'; markdown: string }

export type Settings = {
  baseUrl: string
  apiKey: string
  model: string
  triggerMode: 'smart' | 'always' | 'manual'
  maxPrefetch: number
  pageCharBudget: number
  systemPromptOverride: string
  searchProvider: 'ddg' | 'perplexity'
  perplexityApiKey: string
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://ollama.com/v1',
  apiKey: '',
  model: 'glm-5.2',
  triggerMode: 'smart',
  maxPrefetch: 5,
  pageCharBudget: 8000,
  systemPromptOverride: '',
  searchProvider: 'ddg',
  perplexityApiKey: '',
}
