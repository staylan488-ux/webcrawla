import type { DisplayMessage, ExtractedSource } from '../shared/types'
import type { ChatMessage } from './llm'

export type ConversationRecord = {
  jobId: string
  query: string
  messages: ChatMessage[]
  sources: ExtractedSource[]
  display: DisplayMessage[]
  updatedAt: number
}

const JOB_PREFIX = 'wc:job:'
const QUERY_PREFIX = 'wc:query:'
const MAX_CONVERSATIONS = 5

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

export async function saveConversation(rec: ConversationRecord): Promise<void> {
  await chrome.storage.session.set({
    [JOB_PREFIX + rec.jobId]: rec,
    [QUERY_PREFIX + normalizeQuery(rec.query)]: rec.jobId,
  })
  await prune()
}

export async function loadConversation(jobId: string): Promise<ConversationRecord | null> {
  const key = JOB_PREFIX + jobId
  const stored = await chrome.storage.session.get(key)
  return (stored[key] as ConversationRecord | undefined) ?? null
}

export async function findConversationByQuery(query: string): Promise<ConversationRecord | null> {
  const key = QUERY_PREFIX + normalizeQuery(query)
  const stored = await chrome.storage.session.get(key)
  const jobId = stored[key] as string | undefined
  return jobId ? loadConversation(jobId) : null
}

async function prune(): Promise<void> {
  const all = await chrome.storage.session.get(null)
  const jobs = Object.entries(all)
    .filter(([k]) => k.startsWith(JOB_PREFIX))
    .map(([, v]) => v as ConversationRecord)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const stale = jobs.slice(MAX_CONVERSATIONS)
  if (!stale.length) return
  const keys = stale.flatMap(r => [JOB_PREFIX + r.jobId, QUERY_PREFIX + normalizeQuery(r.query)])
  await chrome.storage.session.remove(keys)
}
