import { describe, expect, it } from 'vitest'
import { activeAlerts, describeAlert, isStale } from '../app/utils/alerts'

const e = (kind: 'cpu' | 'memory' | 'disk', state: 'alert' | 'ok', ts: string, mount?: string) =>
  ({ kind, state, value: 95, threshold: 90, ts, ...(mount ? { mount } : {}) })

describe('activeAlerts', () => {
  it('keeps the latest event per kind and mount, and returns only those still alerting', () => {
    const list = [
      e('memory', 'alert', '2026-01-01T10:00:00Z'),
      e('memory', 'ok', '2026-01-01T11:00:00Z'),
      e('cpu', 'alert', '2026-01-01T10:30:00Z'),
      e('disk', 'alert', '2026-01-01T09:00:00Z', '/'),
      e('disk', 'alert', '2026-01-01T09:30:00Z', '/data'),
      e('disk', 'ok', '2026-01-01T10:00:00Z', '/data')
    ]
    expect(activeAlerts(list).map(a => `${a.kind}${a.mount ?? ''}`).sort()).toEqual(['cpu', 'disk/'])
  })
  it('does not depend on the input order', () => {
    const list = [e('cpu', 'ok', '2026-01-01T11:00:00Z'), e('cpu', 'alert', '2026-01-01T10:00:00Z')]
    expect(activeAlerts(list)).toEqual([])
    expect(activeAlerts([...list].reverse())).toEqual([])
  })
})

describe('isStale', () => {
  it('is stale when nothing was ever seen or the last message is older than the limit', () => {
    const now = Date.parse('2026-01-01T12:00:00Z')
    expect(isStale(undefined, now, 600_000)).toBe(true)
    expect(isStale('2026-01-01T11:49:00Z', now, 600_000)).toBe(true)
    expect(isStale('2026-01-01T11:55:00Z', now, 600_000)).toBe(false)
  })
})

describe('describeAlert', () => {
  it('writes a readable sentence for each kind', () => {
    expect(describeAlert(e('cpu', 'alert', 't'))).toBe('CPU at 95% (threshold 90%)')
    expect(describeAlert(e('memory', 'alert', 't'))).toBe('Memory at 95% (threshold 90%)')
    expect(describeAlert(e('disk', 'alert', 't', '/data'))).toBe('Disk /data at 95% (threshold 90%)')
  })
})
