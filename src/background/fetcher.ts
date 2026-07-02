export type FetchPageResult = { ok: true; html: string } | { ok: false; error: string }

export async function fetchPage(
  url: string,
  opts: { timeoutMs?: number; maxChars?: number } = {},
): Promise<FetchPageResult> {
  const { timeoutMs = 4000, maxChars = 1_500_000 } = opts
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'not an http(s) url' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      credentials: 'omit',
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const type = res.headers.get('content-type') ?? ''
    if (type && !type.includes('html')) return { ok: false, error: `unsupported content-type: ${type}` }
    const html = (await res.text()).slice(0, maxChars)
    return { ok: true, html }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}
