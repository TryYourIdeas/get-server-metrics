import { bigint, boolean, index, integer, pgTable, real, serial, text, timestamp, unique } from 'drizzle-orm/pg-core'

export const samples = pgTable('samples', {
  id: serial('id').primaryKey(),
  // Existing single-machine rows are backfilled with 'local' by the column default.
  hostId: text('host_id').notNull().default('local'),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  cpuPercent: real('cpu_percent').notNull(),
  memUsed: bigint('mem_used', { mode: 'number' }).notNull(),
  memTotal: bigint('mem_total', { mode: 'number' }).notNull()
}, t => [
  index('samples_host_ts_idx').on(t.hostId, t.ts),
  unique('samples_host_ts_unique').on(t.hostId, t.ts)
])

export const diskSamples = pgTable('disk_samples', {
  id: serial('id').primaryKey(),
  sampleId: integer('sample_id').notNull().references(() => samples.id, { onDelete: 'cascade' }),
  mount: text('mount').notNull(),
  used: bigint('used', { mode: 'number' }).notNull(),
  total: bigint('total', { mode: 'number' }).notNull()
}, t => [index('disk_samples_sample_idx').on(t.sampleId)])

export const events = pgTable('events', {
  id: serial('id').primaryKey(),
  hostId: text('host_id').notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  kind: text('kind').notNull(),
  state: text('state').notNull(),
  value: real('value').notNull(),
  threshold: real('threshold').notNull(),
  mount: text('mount').notNull().default('') // '' for cpu/memory events
}, t => [
  index('events_host_ts_idx').on(t.hostId, t.ts),
  unique('events_dedupe').on(t.hostId, t.ts, t.kind, t.state, t.mount)
])

export const hosts = pgTable('hosts', {
  hostId: text('host_id').primaryKey(),
  online: boolean('online').notNull().default(false),
  lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow()
})
