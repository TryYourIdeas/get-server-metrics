export function eventMonitorUrl(path: string): string {
  const base = process.env.EVENT_MONITOR_URL || 'http://127.0.0.1:3100'
  return new URL(path, `${base.replace(/\/+$/, '')}/`).toString()
}

export function eventMonitorHeaders(): HeadersInit {
  const token = process.env.EVENT_MONITOR_TOKEN
  return token ? { authorization: `Bearer ${token}` } : {}
}

/**
 * Sends a write (PUT/DELETE) to the event monitor and returns its JSON answer. The monitor's own 400 messages
 * are passed on so forms can show them; anything else becomes a 502.
 */
export async function forwardToMonitor(path: string, init: { method: 'PUT' | 'DELETE'; body?: unknown }): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(eventMonitorUrl(path), {
      method: init.method,
      headers: { ...eventMonitorHeaders(), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(5000)
    })
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'Event monitor is unavailable' })
  }
  if (response.status === 400) {
    const message = await response.json().then((b: { error?: string }) => b.error).catch(() => undefined)
    throw createError({ statusCode: 400, statusMessage: message ?? 'Invalid request' })
  }
  if (!response.ok) throw createError({ statusCode: 502, statusMessage: 'Event monitor is unavailable' })
  return response.json()
}
