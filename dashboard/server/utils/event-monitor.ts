export function eventMonitorUrl(path: string): string {
  const base = process.env.EVENT_MONITOR_URL || 'http://127.0.0.1:3100'
  return new URL(path, `${base.replace(/\/+$/, '')}/`).toString()
}

export function eventMonitorHeaders(): HeadersInit {
  const token = process.env.EVENT_MONITOR_TOKEN
  return token ? { authorization: `Bearer ${token}` } : {}
}
