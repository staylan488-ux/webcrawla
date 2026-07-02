import { describe, expect, it, vi } from 'vitest'
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

  it('Regenerate button survives a follow-up finish()', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    const shadow = host.shadowRoot!
    const actions = () => shadow.querySelector('.actions') as HTMLElement

    panel.setLoading('Reading…')
    panel.appendToken('summary')
    panel.finish(vi.fn())
    panel.addUserMessage('q')
    panel.beginExchange()
    panel.setLoading('Thinking…')
    panel.appendToken('a')
    panel.finish() // follow-up finish: no arg

    expect(actions().textContent).toContain('Regenerate')
  })

  it('clicking Regenerate clears the saved callback so a later bare finish() shows no button', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    const shadow = host.shadowRoot!
    const actions = () => shadow.querySelector('.actions') as HTMLElement

    panel.setLoading('Reading…')
    panel.appendToken('summary')
    panel.finish(vi.fn())

    const regenerateBtn = actions().querySelector('button') as HTMLButtonElement
    regenerateBtn.click()

    panel.setLoading('Reading…')
    panel.appendToken('regenerated')
    panel.finish() // no arg, and the reset from Regenerate should have cleared the saved callback

    expect(actions().querySelector('button')).toBeNull()
  })

  it('enableChat renders an input and submits questions', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    const asked: string[] = []
    panel.enableChat(q => asked.push(q))
    const input = host.shadowRoot!.querySelector('.chatrow input') as HTMLInputElement
    input.value = '  why though?  '
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(asked).toEqual(['why though?'])
    expect(input.value).toBe('')
  })

  it('follow-up exchanges render independently of the summary', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    panel.setLoading('Reading…')
    panel.appendToken('SUMMARY')
    panel.finish()
    panel.addUserMessage('why?')
    panel.beginExchange()
    panel.appendToken('FOLLOWUP')
    panel.finish()
    const blocks = host.shadowRoot!.querySelectorAll('.body .exchange')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].textContent).toBe('SUMMARY')
    expect(blocks[1].textContent).toBe('FOLLOWUP')
    expect(host.shadowRoot!.querySelector('.user-q')!.textContent).toBe('why?')
  })

  it('chat input disables during a follow-up stream and re-enables on finish', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    panel.enableChat(() => {})
    const input = host.shadowRoot!.querySelector('.chatrow input') as HTMLInputElement
    panel.beginExchange()
    expect(input.disabled).toBe(true)
    panel.appendToken('x')
    panel.finish()
    expect(input.disabled).toBe(false)
  })

  it('a follow-up error offers retry inside its exchange and removes the block on retry', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    panel.setLoading('Reading…')
    panel.appendToken('SUMMARY')
    panel.finish()
    panel.addUserMessage('why?')
    panel.beginExchange()
    let retried = false
    panel.setError('boom', () => { retried = true })
    const blocks = host.shadowRoot!.querySelectorAll('.body .exchange')
    expect(blocks).toHaveLength(2)
    const retryBtn = blocks[1].querySelector('button') as HTMLButtonElement
    retryBtn.click()
    expect(retried).toBe(true)
    expect(host.shadowRoot!.querySelectorAll('.body .exchange')).toHaveLength(1)
    expect(host.shadowRoot!.querySelector('.body')!.textContent).toContain('SUMMARY')
  })

  it('restore renders a display transcript with working citations', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const panel = createPanel(host, { model: 'm', endpointHost: 'h' })
    panel.restore(
      [
        { role: 'assistant', markdown: 'Summary [1].' },
        { role: 'user', markdown: 'why?' },
        { role: 'assistant', markdown: 'Because [1].' },
      ],
      [{ index: 1, url: 'https://a.com', title: 'A', ok: true }],
    )
    const rootEl = host.shadowRoot!
    expect(rootEl.querySelectorAll('.body .exchange')).toHaveLength(2)
    expect(rootEl.querySelector('.user-q')!.textContent).toBe('why?')
    expect(rootEl.querySelectorAll('sup.cite a')).toHaveLength(2)
    expect(rootEl.querySelectorAll('.sources a')).toHaveLength(1)
  })
})
