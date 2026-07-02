import { DEFAULT_SETTINGS, type Settings } from './types'

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings')
  return { ...DEFAULT_SETTINGS, ...((stored.settings as Partial<Settings>) ?? {}) }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await loadSettings()
  await chrome.storage.local.set({ settings: { ...current, ...patch } })
}
