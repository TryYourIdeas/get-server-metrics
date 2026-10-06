import type { UsageEvent } from 'computer-usage-agent/protocol'

const key = (e: Pick<UsageEvent, 'kind' | 'mount'>) => `${e.kind}:${e.mount ?? ''}`

/** The alerts still open: the newest event per kind (and disk mount), kept only if that event is an alert. */
export function activeAlerts(events: UsageEvent[]): UsageEvent[] {
  const latest = new Map<string, UsageEvent>()
  for (const e of events) {
    const prev = latest.get(key(e))
    if (!prev || Date.parse(e.ts) >= Date.parse(prev.ts)) latest.set(key(e), e)
  }
  return [...latest.values()].filter(e => e.state === 'alert')
}

/** A host is stale when nothing (heartbeat, event or status) arrived for longer than `staleAfterMs`. */
export const isStale = (lastSeen: string | undefined, now: number, staleAfterMs: number): boolean =>
  !lastSeen || now - Date.parse(lastSeen) > staleAfterMs

export function describeAlert(e: UsageEvent): string {
  const what = e.kind === 'cpu' ? 'CPU' : e.kind === 'memory' ? 'Memory' : `Disk ${e.mount}`
  return `${what} at ${Math.round(e.value)}% (threshold ${e.threshold}%)`
}
