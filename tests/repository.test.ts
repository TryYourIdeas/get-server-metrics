import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Reading } from 'computer-usage-agent/protocol'
import { createDb } from '../server/db'
import { runMigrations } from '../server/db/migrate'
import { createRepository } from '../server/utils/repository'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/computer-usage-test'
const { db, pool } = createDb(url)
const repo = createRepository(db)
const r = (cpu: number, ts: string): Reading => ({
  ts, cpuPercent: cpu, memUsed: 5, memTotal: 10,
  disks: [{ mount: '/', used: 1, total: 2 }, { mount: '/data', used: 3, total: 4 }]
})

beforeAll(() => runMigrations(db))
beforeEach(() => db.execute(sql`truncate samples, events, hosts restart identity cascade`))
afterAll(() => pool.end())

describe('samples', () => {
  it('returns [] when there is no data', async () => {
    expect(await repo.getHistory('h1', '1h')).toEqual([])
    expect(await repo.getLatest('h1')).toBeNull()
  })
  it('saves a sample with its disks and reads it back', async () => {
    await repo.saveSample('h1', r(42, '2026-01-01T11:59:00Z'))
    const h = await repo.getHistory('h1', '1h', new Date('2026-01-01T12:00:00Z'))
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ cpuPercent: 42, memUsed: 5, memTotal: 10 })
    expect(h[0]!.disks).toEqual([{ mount: '/', used: 1, total: 2 }, { mount: '/data', used: 3, total: 4 }])
  })
  it('keeps hosts separate', async () => {
    await repo.saveSample('h1', r(1, '2026-01-01T11:59:00Z'))
    await repo.saveSample('h2', r(2, '2026-01-01T11:59:00Z'))
    const now = new Date('2026-01-01T12:00:00Z')
    expect((await repo.getHistory('h1', '1h', now)).map(p => p.cpuPercent)).toEqual([1])
    expect((await repo.getHistory('h2', '1h', now)).map(p => p.cpuPercent)).toEqual([2])
  })
  it('filters by range and orders ascending by ts', async () => {
    const now = new Date('2026-01-01T12:00:00Z')
    await repo.saveSample('h1', r(3, '2026-01-01T11:30:00Z'))
    await repo.saveSample('h1', r(1, '2026-01-01T10:00:00Z')) // outside 1h
    await repo.saveSample('h1', r(2, '2026-01-01T11:10:00Z'))
    expect((await repo.getHistory('h1', '1h', now)).map(p => p.cpuPercent)).toEqual([2, 3])
  })
  it('ignores a duplicate delivery of the same sample (QoS 1 redelivery)', async () => {
    expect(await repo.saveSample('h1', r(1, '2026-01-01T11:59:00Z'))).toEqual(expect.any(Number))
    expect(await repo.saveSample('h1', r(1, '2026-01-01T11:59:00Z'))).toBeNull()
    expect(await repo.getHistory('h1', '1h', new Date('2026-01-01T12:00:00Z'))).toHaveLength(1)
    const left = await db.execute(sql`select count(*)::int as n from disk_samples`)
    expect(left.rows[0]).toEqual({ n: 2 })
  })
  it('saves a sample with no disks', async () => {
    await repo.saveSample('h1', { ...r(1, '2026-01-01T11:59:00Z'), disks: [] })
    expect((await repo.getHistory('h1', '1h', new Date('2026-01-01T12:00:00Z')))[0]!.disks).toEqual([])
  })
  it('returns the latest sample for a host', async () => {
    await repo.saveSample('h1', r(1, '2026-01-01T10:00:00Z'))
    await repo.saveSample('h1', r(2, '2026-01-01T11:00:00Z'))
    expect((await repo.getLatest('h1'))?.cpuPercent).toBe(2)
  })
  it('deletes samples and their disks only for the selected host', async () => {
    await repo.saveSample('h1', r(1, '2026-01-01T10:00:00Z'))
    await repo.saveSample('h2', r(2, '2026-01-01T10:00:00Z'))
    expect(await repo.deleteHostLogs('h1')).toEqual({ samples: 1, events: 0 })
    expect(await repo.getHistory('h1', '7d', new Date('2026-01-02T00:00:00Z'))).toEqual([])
    expect((await repo.getHistory('h2', '7d', new Date('2026-01-02T00:00:00Z'))).map(p => p.cpuPercent)).toEqual([2])
    expect((await db.execute(sql`select count(*)::int as n from disk_samples`)).rows[0]).toEqual({ n: 2 })
  })
  it('prunes samples older than the cutoff and cascades to their disks', async () => {
    await repo.saveSample('h1', r(1, '2026-01-01T00:00:00Z'))
    await repo.saveSample('h1', r(2, '2026-01-20T00:00:00Z'))
    expect(await repo.pruneOlderThan(new Date('2026-01-10T00:00:00Z'))).toBe(1)
    expect((await repo.getHistory('h1', '7d', new Date('2026-01-21T00:00:00Z'))).map(p => p.cpuPercent)).toEqual([2])
    expect((await db.execute(sql`select count(*)::int as n from disk_samples`)).rows[0]).toEqual({ n: 2 })
  })
})

describe('events', () => {
  const e = { kind: 'memory' as const, state: 'alert' as const, value: 93, threshold: 90, ts: '2026-01-01T11:00:00Z' }
  it('stores events and lists them newest first, with disk mounts', async () => {
    await repo.saveEvent('h1', e)
    await repo.saveEvent('h1', { kind: 'disk', state: 'alert', value: 95, threshold: 90, mount: '/data', ts: '2026-01-01T12:00:00Z' })
    const list = await repo.getRecentEvents('h1', 10)
    expect(list.map(x => x.kind)).toEqual(['disk', 'memory'])
    expect(list[0]!.mount).toBe('/data')
    expect(list[1]!.mount).toBeUndefined()
  })
  it('ignores a duplicate delivery of the same event', async () => {
    expect(await repo.saveEvent('h1', e)).toBe(true)
    expect(await repo.saveEvent('h1', e)).toBe(false)
    expect(await repo.getRecentEvents('h1', 10)).toHaveLength(1)
  })
  it('honours the limit and prunes old events', async () => {
    await repo.saveEvent('h1', e)
    await repo.saveEvent('h1', { ...e, state: 'ok', ts: '2026-01-02T00:00:00Z' })
    expect(await repo.getRecentEvents('h1', 1)).toHaveLength(1)
    expect(await repo.pruneEventsOlderThan(new Date('2026-01-01T12:00:00Z'))).toBe(1)
    expect(await repo.getRecentEvents('h1', 10)).toHaveLength(1)
  })
  it('deletes events only for the selected host', async () => {
    await repo.saveEvent('h1', e)
    await repo.saveEvent('h2', e)
    expect(await repo.deleteHostLogs('h1')).toEqual({ samples: 0, events: 1 })
    expect(await repo.getRecentEvents('h1', 10)).toEqual([])
    expect(await repo.getRecentEvents('h2', 10)).toHaveLength(1)
  })
})

describe('hosts', () => {
  it('registers a host on first contact and tracks online state and last seen', async () => {
    await repo.touchHost('h1', { online: true }, new Date('2026-01-01T00:00:00Z'))
    await repo.touchHost('h1', { online: false }, new Date('2026-01-01T00:05:00Z'))
    await repo.touchHost('h0', { online: true }, new Date('2026-01-01T00:01:00Z'))
    expect(await repo.listHosts()).toEqual([
      { hostId: 'h0', online: true, lastSeen: '2026-01-01T00:01:00.000Z' },
      { hostId: 'h1', online: false, lastSeen: '2026-01-01T00:05:00.000Z' }
    ])
  })
  it('keeps the online flag when touched without one', async () => {
    await repo.touchHost('h1', { online: true })
    await repo.touchHost('h1')
    expect((await repo.listHosts())[0]!.online).toBe(true)
  })
})
