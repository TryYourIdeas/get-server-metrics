import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { join } from 'node:path'
import type { Db } from './index'

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') })
}
