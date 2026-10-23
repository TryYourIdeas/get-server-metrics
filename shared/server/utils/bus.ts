import type { Reading, UsageEvent } from 'agent/protocol'

export type BusEvent =
  | { type: 'reading'; host: string; reading: Reading; requestId?: string; stored: boolean }
  | { type: 'event'; host: string; event: UsageEvent }
  | { type: 'status'; host: string; online: boolean }
  | { type: 'broker'; connected: boolean }

export interface Bus {
  emit(e: BusEvent): void
  subscribe(fn: (e: BusEvent) => void): () => void
}

export function createBus(): Bus {
  const listeners = new Set<(e: BusEvent) => void>()
  return {
    emit(e) { for (const fn of listeners) { try { fn(e) } catch { /* one broken listener must not stop the others */ } } },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } }
  }
}

// One bus per process, kept across dev HMR reloads so open SSE connections stay subscribed.
const g = globalThis as { __computerUsageBus?: Bus }
export const bus: Bus = (g.__computerUsageBus ??= createBus())
