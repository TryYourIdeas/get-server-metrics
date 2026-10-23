import { randomUUID } from 'node:crypto'

interface Deps {
  publish: (host: string, requestId: string) => Promise<void>
  now?: () => number
  cooldownMs?: number
  newId?: () => string
}

/** Sends "check now" requests, at most one per host per cooldown so repeated clicks cannot flood a machine. */
export function createCheckRequester({ publish, now = Date.now, cooldownMs = 2000, newId = randomUUID }: Deps) {
  const lastAt = new Map<string, number>()
  return async (host: string): Promise<{ ok: true; requestId: string } | { ok: false; reason: 'cooldown' }> => {
    const t = now()
    const prev = lastAt.get(host)
    if (prev !== undefined && t - prev < cooldownMs) return { ok: false, reason: 'cooldown' }
    lastAt.set(host, t)
    const requestId = newId()
    try {
      await publish(host, requestId)
    } catch (err) {
      if (lastAt.get(host) === t) lastAt.delete(host)
      throw err
    }
    return { ok: true, requestId }
  }
}
