import { describe, expect, it } from 'vitest'
import type { Reading, UsageEvent } from 'agent/protocol'
import type { OverviewEntry } from '../shared/server/utils/repository'
import { applyStreamMessage, cardState, sortEntries } from '../dashboard/app/utils/overview'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const STALE = 600_000
const fresh = '2026-01-01T11:59:00Z'
const old = '2026-01-01T10:00:00Z'
const reading = (cpu = 10): Reading => ({ ts: fresh, cpuPercent: cpu, memUsed: 5, memTotal: 10, disks: [{ mount: '/', used: 1, total: 2 }] })
const ev = (state: 'alert' | 'ok', ts = fresh, kind: 'cpu' | 'memory' = 'memory'): UsageEvent => ({ kind, state, value: 95, threshold: 90, ts })
const entry = (hostId: string, o: Partial<OverviewEntry> = {}): OverviewEntry =>
  ({ hostId, online: true, lastSeen: fresh, current: reading(), events: [], ...o })

describe('cardState', () => {
  it('is offline when the host is marked offline', () => expect(cardState(entry('a', { online: false }), NOW, STALE)).toBe('offline'))
  it('is stale when nothing arrived for too long', () => expect(cardState(entry('a', { lastSeen: old }), NOW, STALE)).toBe('stale'))
  it('is alert when an alert is still open', () => expect(cardState(entry('a', { events: [ev('alert')] }), NOW, STALE)).toBe('alert'))
  it('is ok when the latest event recovered', () => expect(cardState(entry('a', { events: [ev('ok', fresh), ev('alert', '2026-01-01T11:50:00Z')] }), NOW, STALE)).toBe('ok'))
  it('is waiting when there is no reading yet', () => expect(cardState(entry('a', { current: null }), NOW, STALE)).toBe('waiting'))
  it('is ok for a machine with no disks', () => {
    expect(cardState(entry('a', { current: { ...reading(), disks: [] } }), NOW, STALE)).toBe('ok')
  })
  it('an offline machine with an old unresolved alert is offline, not alert', () => {
    expect(cardState(entry('a', { online: false, events: [ev('alert')] }), NOW, STALE)).toBe('offline')
  })
})

describe('sortEntries', () => {
  const list = [
    entry('d-ok'), entry('c-offline', { online: false }), entry('b-alert', { events: [ev('alert')] }),
    entry('a-ok'), entry('e-stale', { lastSeen: old }), entry('0-alert', { events: [ev('alert', fresh, 'cpu')] }),
    entry('f-waiting', { current: null })
  ]

  it('puts alerting machines first, then offline/stale, then the rest, ties by id', () => {
    expect(sortEntries(list, NOW, STALE).map(e => e.hostId)).toEqual(['0-alert', 'b-alert', 'c-offline', 'e-stale', 'a-ok', 'd-ok', 'f-waiting'])
  })

  it('returns a new array and does not mutate the input', () => {
    const copy = [...list]
    const sorted = sortEntries(list, NOW, STALE)
    expect(sorted).not.toBe(list)
    expect(list).toEqual(copy)
  })
})

describe('applyStreamMessage', () => {
  const nowIso = '2026-01-01T12:00:00Z'

  it('a reading sets current, marks the host online and refreshes lastSeen', () => {
    const before = [entry('a', { online: false, current: null, lastSeen: old })]
    const next = applyStreamMessage(before, { type: 'reading', host: 'a', reading: reading(42), stored: true }, nowIso)
    expect(next[0]).toMatchObject({ online: true, lastSeen: nowIso, current: { cpuPercent: 42 } })
    expect(before[0]!.current).toBeNull()
  })

  it('an event is prepended and the list is capped at 50', () => {
    const many = Array.from({ length: 50 }, (_, i) => ev('ok', `2026-01-01T11:${String(i).padStart(2, '0')}:00Z`))
    const next = applyStreamMessage([entry('a', { events: many })], { type: 'event', host: 'a', event: ev('alert') }, nowIso)
    expect(next[0]!.events).toHaveLength(50)
    expect(next[0]!.events[0]).toMatchObject({ state: 'alert' })
  })

  it('a status message updates online and lastSeen', () => {
    const next = applyStreamMessage([entry('a')], { type: 'status', host: 'a', online: false }, nowIso)
    expect(next[0]).toMatchObject({ online: false, lastSeen: nowIso })
  })

  it('returns the same array for an unknown host, broker and ping messages', () => {
    const before = [entry('a')]
    expect(applyStreamMessage(before, { type: 'reading', host: 'zzz', reading: reading(), stored: true }, nowIso)).toBe(before)
    expect(applyStreamMessage(before, { type: 'broker', connected: false }, nowIso)).toBe(before)
    expect(applyStreamMessage(before, { type: 'ping' }, nowIso)).toBe(before)
  })
})
