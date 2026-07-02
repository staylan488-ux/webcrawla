import { describe, expect, it } from 'vitest'
import { shouldAutoRun } from '../src/content/trigger'

describe('shouldAutoRun', () => {
  it('always mode always runs', () => {
    expect(shouldAutoRun('gmail login', 'always')).toBe(true)
  })
  it('manual mode never runs', () => {
    expect(shouldAutoRun('how does mrna vaccine work', 'manual')).toBe(false)
  })
  it('smart: question-word queries run', () => {
    expect(shouldAutoRun('how does a heat pump work', 'smart')).toBe(true)
    expect(shouldAutoRun('why is the sky blue', 'smart')).toBe(true)
    expect(shouldAutoRun('what is the capital of mongolia', 'smart')).toBe(true)
  })
  it('smart: trailing question mark runs', () => {
    expect(shouldAutoRun('best budget mechanical keyboard 2026?', 'smart')).toBe(true)
  })
  it('smart: research phrasing runs', () => {
    expect(shouldAutoRun('rust vs go for web services', 'smart')).toBe(true)
    expect(shouldAutoRun('difference between tcp and udp', 'smart')).toBe(true)
  })
  it('smart: long queries run', () => {
    expect(shouldAutoRun('mechanical keyboard switch types linear tactile clicky comparison', 'smart')).toBe(true)
  })
  it('smart: navigational queries do not run', () => {
    expect(shouldAutoRun('gmail login', 'smart')).toBe(false)
    expect(shouldAutoRun('github.com', 'smart')).toBe(false)
    expect(shouldAutoRun('vivaldi browser download', 'smart')).toBe(false)
  })
  it('smart: short queries do not run', () => {
    expect(shouldAutoRun('weather', 'smart')).toBe(false)
    expect(shouldAutoRun('nba scores', 'smart')).toBe(false)
  })
})
