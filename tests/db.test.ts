import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb } from '../server/db'
import { runMigrations } from '../server/db/migrate'

export const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/computer-usage-test'
const { db, pool } = createDb(TEST_URL)
afterAll(() => pool.end())

describe('migrations', () => {
  it('creates samples and disk_samples tables and is idempotent', async () => {
    await runMigrations(db)
    await runMigrations(db)
    const r = await db.execute(sql`select table_name from information_schema.tables where table_schema='public' and table_name in ('samples','disk_samples')`)
    expect(r.rows.map((x: any) => x.table_name).sort()).toEqual(['disk_samples', 'samples'])
  })
})
