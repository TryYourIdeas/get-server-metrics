import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '../server/db'
import { runMigrations } from '../server/db/migrate'
import { createRepository } from '../server/utils/repository'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/computer-usage-test'
const { db, pool } = createDb(url)
const repo = createRepository(db)
const m = (cpu: number) => ({ cpuPercent: cpu, memUsed: 5, memTotal: 10, disks: [{ mount: '/', used: 1, total: 2 }, { mount: '/data', used: 3, total: 4 }] })

beforeAll(() => runMigrations(db))
beforeEach(() => db.execute(sql`truncate samples restart identity cascade`))
afterAll(() => pool.end())

describe('repository', () => {
  it('returns [] when there is no data', async () => {
    expect(await repo.getHistory('1h')).toEqual([])
  })
  it('saves a sample with its disks and reads it back', async () => {
    const now = new Date('2026-01-01T12:00:00Z')
    await repo.saveSample(m(42), new Date('2026-01-01T11:59:00Z'))
    const h = await repo.getHistory('1h', now)
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ cpuPercent: 42, memUsed: 5, memTotal: 10 })
    expect(h[0].disks).toEqual([{ mount: '/', used: 1, total: 2 }, { mount: '/data', used: 3, total: 4 }])
  })
  it('filters by range and orders ascending by ts', async () => {
    const now = new Date('2026-01-01T12:00:00Z')
    await repo.saveSample(m(3), new Date('2026-01-01T11:30:00Z'))
    await repo.saveSample(m(1), new Date('2026-01-01T10:00:00Z')) // outside 1h
    await repo.saveSample(m(2), new Date('2026-01-01T11:10:00Z'))
    const h = await repo.getHistory('1h', now)
    expect(h.map(p => p.cpuPercent)).toEqual([2, 3])
  })
  it('saves a sample with no disks', async () => {
    await repo.saveSample({ ...m(1), disks: [] }, new Date())
    expect((await repo.getHistory('1h'))[0].disks).toEqual([])
  })
})
