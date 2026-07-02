import { describe, expect, it } from 'vitest'
import { createPanel } from '../src/content/panel'

describe('createPanel', () => {
  it('resets the markdown accumulator on error so a retry renders clean', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    const shadow = host.shadowRoot!
    const body = () => shadow.querySelector('.body') as HTMLElement

    // First run: streams a token, then fails.
    panel.setLoading('Reading…')
    panel.appendToken('OLD ')
    panel.setError('boom', () => {})

    // Retry: loading should show the shimmer again, not stale error text.
    panel.setLoading('Reading…')
    expect(body().querySelector('.shimmer')).not.toBeNull()
    expect(body().textContent).not.toContain('boom')

    // New run streams fresh tokens and finishes.
    panel.appendToken('NEW')
    panel.finish()

    expect(body().textContent).toContain('NEW')
    expect(body().textContent).not.toContain('OLD')
  })

  it('finish(onRerun) renders a Regenerate button that resets state and reruns', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    const shadow = host.shadowRoot!
    const body = () => shadow.querySelector('.body') as HTMLElement
    const actions = () => shadow.querySelector('.actions') as HTMLElement

    let rerunCount = 0
    panel.setLoading('Reading…')
    panel.appendToken('OLD ANSWER')
    panel.finish(() => { rerunCount++ })

    const regenerateBtn = actions().querySelector('button') as HTMLButtonElement
    expect(regenerateBtn).not.toBeNull()
    expect(regenerateBtn.textContent).toContain('Regenerate')

    regenerateBtn.click()
    expect(rerunCount).toBe(1)

    // Accumulator must be reset before rerun so a stale answer can't leak through.
    panel.setLoading('Reading…')
    expect(body().querySelector('.shimmer')).not.toBeNull()
    expect(body().textContent).not.toContain('OLD ANSWER')

    panel.appendToken('NEW')
    panel.finish()
    expect(body().textContent).toContain('NEW')
    expect(body().textContent).not.toContain('OLD ANSWER')
  })

  it('finish() with no argument renders no action button', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    const shadow = host.shadowRoot!
    const actions = () => shadow.querySelector('.actions') as HTMLElement

    panel.setLoading('Reading…')
    panel.appendToken('SOME ANSWER')
    panel.finish()

    expect(actions().querySelector('button')).toBeNull()
  })
})
