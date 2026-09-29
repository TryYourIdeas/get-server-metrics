import { bigint, index, integer, pgTable, real, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const samples = pgTable('samples', {
  id: serial('id').primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  cpuPercent: real('cpu_percent').notNull(),
  memUsed: bigint('mem_used', { mode: 'number' }).notNull(),
  memTotal: bigint('mem_total', { mode: 'number' }).notNull()
}, t => [index('samples_ts_idx').on(t.ts)])

export const diskSamples = pgTable('disk_samples', {
  id: serial('id').primaryKey(),
  sampleId: integer('sample_id').notNull().references(() => samples.id, { onDelete: 'cascade' }),
  mount: text('mount').notNull(),
  used: bigint('used', { mode: 'number' }).notNull(),
  total: bigint('total', { mode: 'number' }).notNull()
}, t => [index('disk_samples_sample_idx').on(t.sampleId)])
