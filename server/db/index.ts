import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

export type Db = NodePgDatabase<typeof schema>
export const DEFAULT_URL = 'postgres://postgres:postgres@localhost:5433/computer-usage'

export function createDb(url: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: url })
  return { db: drizzle(pool, { schema }), pool }
}

let shared: { db: Db; pool: pg.Pool } | undefined
export function getDb(): Db {
  shared ??= createDb(process.env.DATABASE_URL ?? DEFAULT_URL)
  return shared.db
}
