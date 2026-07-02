import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSettings, saveSettings } from '../src/shared/settings'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const store: Record<string, unknown> = {}

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => (store[key] === undefined ? {} : { [key]: store[key] }),
      set: async (obj: Record<string, unknown>) => { Object.assign(store, obj) },
    },
  },
})

beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

describe('settings', () => {
  it('returns defaults when nothing stored', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('merges stored values over defaults', async () => {
    store.settings = { apiKey: 'sk-test', model: 'glm-5.2' }
    const s = await loadSettings()
    expect(s.apiKey).toBe('sk-test')
    expect(s.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
  })

  it('saveSettings patches without clobbering', async () => {
    await saveSettings({ apiKey: 'sk-1' })
    await saveSettings({ model: 'other' })
    const s = await loadSettings()
    expect(s.apiKey).toBe('sk-1')
    expect(s.model).toBe('other')
  })

  it('defaults include the search provider settings', async () => {
    const s = await loadSettings()
    expect(s.searchProvider).toBe('ddg')
    expect(s.perplexityApiKey).toBe('')
  })
})
