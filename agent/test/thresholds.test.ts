import { describe, expect, it } from 'vitest'
import type { Reading } from '../src/protocol'
import { DEFAULT_THRESHOLDS, createThresholdEvaluator } from '../src/thresholds'

let n = 0
const r = (o: Partial<Reading> = {}): Reading => ({
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString(), cpuPercent: 10, memUsed: 50, memTotal: 100, disks: [{ mount: '/', used: 10, total: 100 }], ...o
})
const ev = () => createThresholdEvaluator(DEFAULT_THRESHOLDS)

describe('cpu', () => {
  it('alerts only after 3 consecutive checks at or above the threshold', () => {
    const e = ev()
    expect(e(r({ cpuPercent: 95 }))).toEqual([])
    expect(e(r({ cpuPercent: 95 }))).toEqual([])
    const out = e(r({ cpuPercent: 96 }))
    expect(out).toMatchObject([{ kind: 'cpu', state: 'alert', value: 96, threshold: 90 }])
  })
  it('a single spike never alerts and resets the streak', () => {
    const e = ev()
    for (const c of [95, 95, 20, 95, 95]) expect(e(r({ cpuPercent: c }))).toEqual([])
  })
  it('does not repeat while alerting, and emits one ok on recovery', () => {
    const e = ev()
    for (const c of [95, 95, 95]) e(r({ cpuPercent: c }))
    expect(e(r({ cpuPercent: 99 }))).toEqual([])
    expect(e(r({ cpuPercent: 40 }))).toMatchObject([{ kind: 'cpu', state: 'ok' }])
    expect(e(r({ cpuPercent: 40 }))).toEqual([])
  })
})

describe('memory', () => {
  it('alerts at exactly the threshold and recovers below it', () => {
    const e = ev()
    expect(e(r({ memUsed: 90 }))).toMatchObject([{ kind: 'memory', state: 'alert', value: 90 }])
    expect(e(r({ memUsed: 95 }))).toEqual([])
    expect(e(r({ memUsed: 89 }))).toMatchObject([{ kind: 'memory', state: 'ok' }])
  })
  it('ignores a reading with zero total memory', () => {
    expect(ev()(r({ memUsed: 0, memTotal: 0 }))).toEqual([])
  })
})

describe('disk', () => {
  const disks = (a: number, b: number) => [{ mount: '/', used: a, total: 100 }, { mount: '/data', used: b, total: 100 }]
  it('tracks each mount independently', () => {
    const e = ev()
    expect(e(r({ disks: disks(10, 95) }))).toMatchObject([{ kind: 'disk', state: 'alert', mount: '/data' }])
    expect(e(r({ disks: disks(91, 95) }))).toMatchObject([{ kind: 'disk', state: 'alert', mount: '/' }])
    expect(e(r({ disks: disks(10, 95) }))).toMatchObject([{ kind: 'disk', state: 'ok', mount: '/' }])
  })
  it('emits ok when a mount in alert disappears (e.g. USB removed), and is quiet for other vanished mounts', () => {
    const e = ev()
    e(r({ disks: disks(10, 95) }))
    expect(e(r({ disks: [{ mount: '/', used: 10, total: 100 }] }))).toMatchObject([{ kind: 'disk', state: 'ok', mount: '/data' }])
    expect(e(r({ disks: [] }))).toEqual([])
  })
  it('a mount that reappears starts from a fresh state', () => {
    const e = ev()
    e(r({ disks: disks(10, 95) }))
    e(r({ disks: [] }))
    expect(e(r({ disks: disks(10, 95) }))).toMatchObject([{ kind: 'disk', state: 'alert', mount: '/data' }])
  })
})
