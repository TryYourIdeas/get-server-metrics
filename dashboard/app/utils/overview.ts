import type { Reading, UsageEvent } from 'agent/protocol'
import type { OverviewEntry } from '../../../shared/server/utils/repository'
import { activeAlerts, isStale } from './alerts'

export type BusMessage =
  | { type: 'reading'; host: string; reading: Reading; requestId?: string; stored: boolean }
  | { type: 'event'; host: string; event: UsageEvent }
  | { type: 'status'; host: string; online: boolean }
  | { type: 'broker'; connected: boolean }
  | { type: 'ping' }

export type CardState = 'alert' | 'offline' | 'stale' | 'waiting' | 'ok'

const MAX_EVENTS = 50
const RANK: Record<CardState, number> = { alert: 0, offline: 1, stale: 1, waiting: 2, ok: 2 }

/** What a machine's card shows. An offline or silent machine is never "alert": its old alerts cannot be trusted. */
export function cardState(e: OverviewEntry, now: number, staleAfterMs: number): CardState {
  if (!e.online) return 'offline'
  if (isStale(e.lastSeen, now, staleAfterMs)) return 'stale'
  if (activeAlerts(e.events).length > 0) return 'alert'
  return e.current === null ? 'waiting' : 'ok'
}

/** Alerting machines first, then offline/silent ones, then the rest; ties by host id. */
export function sortEntries(entries: OverviewEntry[], now: number, staleAfterMs: number): OverviewEntry[] {
  return entries
    .map(e => ({ e, rank: RANK[cardState(e, now, staleAfterMs)] }))
    .sort((a, b) => a.rank - b.rank || a.e.hostId.localeCompare(b.e.hostId))
    .map(x => x.e)
}

/**
 * Applies one live stream message to the overview without mutating it. Messages about unknown machines,
 * the broker and pings return the very same array, so the caller can tell nothing changed (and refetch
 * when a machine it does not know shows up).
 */
export function applyStreamMessage(entries: OverviewEntry[], msg: BusMessage, nowIso: string): OverviewEntry[] {
  if (msg.type !== 'reading' && msg.type !== 'event' && msg.type !== 'status') return entries
  const i = entries.findIndex(e => e.hostId === msg.host)
  if (i < 0) return entries
  const current = entries[i]!
  const updated: OverviewEntry = { ...current, lastSeen: nowIso, online: msg.type === 'status' ? msg.online : true }
  if (msg.type === 'reading') updated.current = msg.reading
  if (msg.type === 'event') updated.events = [msg.event, ...current.events].slice(0, MAX_EVENTS)
  return entries.map((e, idx) => (idx === i ? updated : e))
}
