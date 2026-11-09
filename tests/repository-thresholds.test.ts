import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Reading } from 'agent/protocol'
import { createDb } from '../shared/server/db'
import { runMigrations } from '../shared/server/db/migrate'
import { createRepository } from '../shared/server/utils/repository'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/computer-usage-test'
const { db, pool } = createDb(url)
const repo = createRepository(db)
const set = { cpuPercent: 80, cpuConsecutive: 2, memoryPercent: 70, diskPercent: 60 }
const reading = (cpu: number, ts: string): Reading => ({ ts, cpuPercent: cpu, memUsed: 5, memTotal: 10, disks: [{ mount: '/', used: 1, total: 2 }] })

beforeAll(() => runMigrations(db))
beforeEach(() => db.execute(sql`truncate samples, events, hosts, threshold_defaults, host_thresholds restart identity cascade`))
afterAll(() => pool.end())

describe('threshold settings', () => {
  it('returns no defaults and no overrides before anything is saved', async () => {
    expect(await repo.getThresholdSettings()).toEqual({ defaults: null, overrides: {} })
  })

  it('saves the defaults and replaces them on a second save', async () => {
    await repo.saveDefaultThresholds(set)
    expect((await repo.getThresholdSettings()).defaults).toEqual(set)
    await repo.saveDefaultThresholds({ ...set, diskPercent: 95 })
    expect((await repo.getThresholdSettings()).defaults).toEqual({ ...set, diskPercent: 95 })
  })

  it('saves a partial override and returns only its values', async () => {
    await repo.saveHostThresholds('web-01', { diskPercent: 50 })
    expect((await repo.getThresholdSettings()).overrides).toEqual({ 'web-01': { diskPercent: 50 } })
  })

  it('replaces an existing override instead of merging', async () => {
    await repo.saveHostThresholds('web-01', { diskPercent: 50, cpuPercent: 70 })
    await repo.saveHostThresholds('web-01', { memoryPercent: 40 })
    expect((await repo.getThresholdSettings()).overrides).toEqual({ 'web-01': { memoryPercent: 40 } })
  })

  it('deleteHostThresholds returns true when a row existed, then false', async () => {
    await repo.saveHostThresholds('web-01', { diskPercent: 50 })
    expect(await repo.deleteHostThresholds('web-01')).toBe(true)
    expect(await repo.deleteHostThresholds('web-01')).toBe(false)
    expect((await repo.getThresholdSettings()).overrides).toEqual({})
  })
})

describe('overview', () => {
  it('returns each host with its latest reading and events newest first', async () => {
    await repo.touchHost('a', { online: true }, new Date('2026-01-01T12:00:00Z'))
    await repo.touchHost('b', { online: false }, new Date('2026-01-01T11:00:00Z'))
    await repo.saveSample('a', reading(10, '2026-01-01T11:50:00Z'))
    await repo.saveSample('a', reading(20, '2026-01-01T11:55:00Z'))
    await repo.saveEvent('a', { kind: 'memory', state: 'alert', value: 93, threshold: 90, ts: '2026-01-01T11:51:00Z' })
    await repo.saveEvent('a', { kind: 'memory', state: 'ok', value: 50, threshold: 90, ts: '2026-01-01T11:56:00Z' })
    const [a, b] = await repo.getOverview()
    expect(a).toMatchObject({ hostId: 'a', online: true })
    expect(a!.current).toMatchObject({ cpuPercent: 20 })
    expect(a!.events.map(e => e.state)).toEqual(['ok', 'alert'])
    expect(b).toMatchObject({ hostId: 'b', online: false, current: null, events: [] })
  })

  it('limits the events per host', async () => {
    await repo.touchHost('a', { online: true })
    for (let i = 0; i < 3; i++) {
      await repo.saveEvent('a', { kind: 'cpu', state: i % 2 ? 'ok' : 'alert', value: 95, threshold: 90, ts: `2026-01-01T11:5${i}:00Z` })
    }
    const [a] = await repo.getOverview(2)
    expect(a!.events).toHaveLength(2)
  })
})
