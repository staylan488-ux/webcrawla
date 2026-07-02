import { describe, expect, it } from 'vitest'
import { FETCH_PAGE_TOOL, buildSystemPrompt, buildUserMessage, formatSource } from '../src/background/prompt'
import type { ExtractedSource } from '../src/shared/types'

const src = (i: number, ok = true): ExtractedSource => ({
  index: i,
  url: `https://example.com/${i}`,
  title: `Title ${i}`,
  ok,
  text: ok ? `Content of page ${i}` : '',
})

describe('prompt assembly', () => {
  it('system prompt mentions citations and the tool', () => {
    const p = buildSystemPrompt()
    expect(p).toMatch(/\[n\]|\[1\]/)
    expect(p).toContain('fetch_page')
  })
  it('override replaces system prompt', () => {
    expect(buildSystemPrompt('be a pirate')).toBe('be a pirate')
  })
  it('formatSource numbers sources and includes content', () => {
    expect(formatSource(src(2))).toContain('[2] Title 2 — https://example.com/2')
    expect(formatSource(src(2))).toContain('Content of page 2')
  })
  it('failed sources are marked unavailable', () => {
    expect(formatSource(src(3, false))).toContain('(content unavailable)')
  })
  it('user message contains query and all sources', () => {
    const msg = buildUserMessage('how do heat pumps work', [src(1), src(2)])
    expect(msg).toContain('how do heat pumps work')
    expect(msg).toContain('[1] Title 1')
    expect(msg).toContain('[2] Title 2')
  })
  it('tool definition is a valid function tool named fetch_page', () => {
    expect(FETCH_PAGE_TOOL.type).toBe('function')
    expect(FETCH_PAGE_TOOL.function.name).toBe('fetch_page')
    expect(FETCH_PAGE_TOOL.function.parameters.required).toContain('url')
  })
})
