import type { Settings } from '../shared/types'

const NAVIGATIONAL = /\b(login|log in|sign in|signup|sign up|download|official site|website)\b/
const DOMAIN_LIKE = /^[\w-]+\.(com|org|net|io|dev|app|gov|edu|co)(\/|$)/
const QUESTION_START = /^(how|what|why|when|where|who|which|can|does|do|is|are|should|will|could|would|explain)\b/
const RESEARCH_PHRASE = /\b(vs\.?|versus|difference between|best way to|how to|meaning of|compared to|comparison)\b/

export function shouldAutoRun(query: string, mode: Settings['triggerMode']): boolean {
  if (mode === 'always') return true
  if (mode === 'manual') return false
  const q = query.trim().toLowerCase()
  if (q.length < 8) return false
  if (DOMAIN_LIKE.test(q) || NAVIGATIONAL.test(q)) return false
  const words = q.split(/\s+/)
  if (words.length < 3) return false
  if (QUESTION_START.test(q) || q.endsWith('?')) return true
  if (RESEARCH_PHRASE.test(q)) return true
  return words.length >= 5
}
