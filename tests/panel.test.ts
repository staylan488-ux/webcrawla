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
})
