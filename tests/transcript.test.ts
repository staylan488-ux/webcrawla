import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findConversationByQuery,
  loadConversation,
  normalizeQuery,
  saveConversation,
  type ConversationRecord,
} from '../src/background/transcript'

const store: Record<string, unknown> = {}

vi.stubGlobal('chrome', {
  storage: {
    session: {
      get: async (key: string | null) => {
        if (key === null) return { ...store }
        return store[key] === undefined ? {} : { [key]: store[key] }
      },
      set: async (obj: Record<string, unknown>) => { Object.assign(store, obj) },
      remove: async (keys: string[]) => { for (const k of keys) delete store[k] },
    },
  },
})

beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

const rec = (jobId: string, query: string, updatedAt: number): ConversationRecord => ({
  jobId,
  query,
  messages: [{ role: 'user', content: 'q' }],
  sources: [{ index: 1, url: 'https://a.com', title: 'A', ok: true, text: 'body' }],
  display: [{ role: 'assistant', markdown: 'answer' }],
  updatedAt,
})

describe('transcript store', () => {
  it('normalizes queries (trim, lowercase, collapse whitespace)', () => {
    expect(normalizeQuery('  How  Do HEAT pumps\twork ')).toBe('how do heat pumps work')
  })

  it('round-trips a conversation by jobId', async () => {
    await saveConversation(rec('j1', 'heat pumps', 100))
    const loaded = await loadConversation('j1')
    expect(loaded?.jobId).toBe('j1')
    expect(loaded?.display[0].markdown).toBe('answer')
  })

  it('returns null for unknown jobId', async () => {
    expect(await loadConversation('nope')).toBeNull()
  })

  it('finds a conversation by query, normalized', async () => {
    await saveConversation(rec('j1', 'Heat Pumps', 100))
    const found = await findConversationByQuery('  heat   pumps ')
    expect(found?.jobId).toBe('j1')
  })

  it('returns null when no conversation exists for a query', async () => {
    expect(await findConversationByQuery('unknown')).toBeNull()
  })

  it('prunes to the 5 most recent conversations including query index entries', async () => {
    for (let i = 1; i <= 7; i++) await saveConversation(rec(`j${i}`, `query ${i}`, i))
    expect(await loadConversation('j1')).toBeNull()
    expect(await loadConversation('j2')).toBeNull()
    expect(await loadConversation('j3')).not.toBeNull()
    expect(await loadConversation('j7')).not.toBeNull()
    expect(await findConversationByQuery('query 1')).toBeNull()
    expect(await findConversationByQuery('query 7')).not.toBeNull()
  })

  it('saving the same query twice repoints the index to the newest job', async () => {
    await saveConversation(rec('j-old', 'same query', 100))
    await saveConversation(rec('j-new', 'same query', 200))
    expect((await findConversationByQuery('same query'))?.jobId).toBe('j-new')
  })

  it('pruning an old job does not delete a repointed query index', async () => {
    await saveConversation(rec('j-old', 'same query', 1))
    await saveConversation(rec('j-new', 'same query', 200))
    for (let i = 3; i <= 6; i++) await saveConversation(rec(`j${i}`, `query ${i}`, i))
    expect(await loadConversation('j-old')).toBeNull()
    expect(await loadConversation('j-new')).not.toBeNull()
    expect((await findConversationByQuery('same query'))?.jobId).toBe('j-new')
  })
})
