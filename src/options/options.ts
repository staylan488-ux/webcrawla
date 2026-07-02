import { loadSettings, saveSettings } from '../shared/settings'
import type { Settings } from '../shared/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

async function restore() {
  const s = await loadSettings()
  $<HTMLInputElement>('baseUrl').value = s.baseUrl
  $<HTMLInputElement>('apiKey').value = s.apiKey
  $<HTMLInputElement>('model').value = s.model
  $<HTMLSelectElement>('triggerMode').value = s.triggerMode
  $<HTMLInputElement>('maxPrefetch').value = String(s.maxPrefetch)
  $<HTMLInputElement>('pageCharBudget').value = String(s.pageCharBudget)
  $<HTMLTextAreaElement>('systemPromptOverride').value = s.systemPromptOverride
}

async function save() {
  const patch: Partial<Settings> = {
    baseUrl: $<HTMLInputElement>('baseUrl').value.trim(),
    apiKey: $<HTMLInputElement>('apiKey').value.trim(),
    model: $<HTMLInputElement>('model').value.trim(),
    triggerMode: $<HTMLSelectElement>('triggerMode').value as Settings['triggerMode'],
    maxPrefetch: Math.min(8, Math.max(1, Number($<HTMLInputElement>('maxPrefetch').value) || 5)),
    pageCharBudget: Math.min(30000, Math.max(1000, Number($<HTMLInputElement>('pageCharBudget').value) || 8000)),
    systemPromptOverride: $<HTMLTextAreaElement>('systemPromptOverride').value.trim(),
  }
  await saveSettings(patch)
  const status = $<HTMLSpanElement>('status')
  status.textContent = 'Saved ✓'
  setTimeout(() => { status.textContent = '' }, 2000)
}

document.addEventListener('DOMContentLoaded', () => {
  void restore()
  $<HTMLButtonElement>('save').addEventListener('click', () => void save())
})
