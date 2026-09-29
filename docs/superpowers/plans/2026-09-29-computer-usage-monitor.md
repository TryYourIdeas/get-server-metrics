# computer-usage Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Nuxt app that samples this machine's CPU, memory and disk usage every 60 seconds, stores each sample in a Postgres database named `computer-usage`, and shows live values plus history on a dashboard.

**Architecture:** An in-process sampler (Nitro plugin, `setInterval`) calls a pure `collectMetrics()` (systeminformation) and a Drizzle-backed repository. Two Nitro API routes serve live values and history. A Tailwind dashboard page renders gauges and SVG history charts. Postgres 18 runs in Docker; the app runs on the host with `npm run dev`.

**Tech Stack:** Nuxt 4, Vue 3, TypeScript, Tailwind v4 (`@tailwindcss/vite`), Drizzle ORM + `pg`, `systeminformation`, Vitest, Docker Compose (Postgres 18).

**Spec:** `docs/superpowers/specs/2026-09-29-computer-usage-monitor-design.md`

## Global Constraints

- All commands run from `/home/luis/data/TYI/web/computer-usage` (its own git repo).
- TypeScript only. Postgres 18 + Drizzle. Tailwind for UI.
- Database name is exactly `computer-usage`; sample interval default `60000` ms (env `SAMPLE_INTERVAL_MS`).
- Sizes are stored in **bytes**; `cpu_percent` is 0–100.
- Tables: `samples(id, ts, cpu_percent, mem_used, mem_total)` and `disk_samples(id, sample_id → samples on delete cascade, mount, used, total)`.
- Debug tracing logs only when `NUXT_ADD_DEBUG_LOGS` is `true` or `1`; errors are always logged with context.
- A failed sample must never crash the server.
- Commit prefixes: `feat:`, `bugfix:`, `config:`, `docs:`, `refactor:`.

## Review Focus

1. Linux `fsSize` returns duplicate/bind/snap/loop mounts → the disk list must be deduplicated and snap/loop filtered (Task 2).
2. `systeminformation` may return `NaN`/`null` for CPU → stored value must be a finite number, never NaN (Task 2).
3. Database down or collector throwing on a tick → tick is logged and skipped, the next tick still runs (Task 4).
4. Slow tick overlapping the next interval → the second tick is skipped, not run concurrently (Task 4).
5. `?range=` missing/invalid on history → default `1h` / HTTP 400; and empty DB returns `[]` and the dashboard shows an empty state, not an error (Tasks 3, 5, 6).
6. Dev HMR/restart creating duplicate timers → plugin clears any previous timer (Task 4).

---

## File Structure

| File | Responsibility |
|---|---|
| `docker-compose.yml`, `docker/init-db.sql` | Postgres 18; creates `computer-usage` and `computer-usage-test` |
| `.env.example` | documents env vars |
| `drizzle.config.ts`, `drizzle/` | migration generation + generated SQL |
| `vitest.config.ts` | test config |
| `server/db/schema.ts` | Drizzle tables |
| `server/db/index.ts` | `createDb(url)`, `getDb()`, `Db` type |
| `server/db/migrate.ts` | `runMigrations(db)` |
| `server/utils/log.ts` | `logInfo/logError/logDebug` |
| `server/utils/collector.ts` | `collectMetrics()` (+ pure `normalizeDisks`, `toMetrics`) |
| `server/utils/repository.ts` | `createRepository(db)` → `saveSample`, `getHistory` |
| `server/utils/range.ts` | `parseRange()` |
| `server/utils/sampler.ts` | `createTick()` overlap-safe tick |
| `server/plugins/sampler.ts` | migrate on boot, start/stop interval |
| `server/api/metrics/current.get.ts`, `history.get.ts` | API routes |
| `app/pages/index.vue`, `app/components/UsageChart.vue`, `app/components/GaugeBar.vue`, `app/assets/css/main.css` | dashboard |
| `tests/*.test.ts` | unit/integration tests |
| `docs/...`, `../docs/architecture/...` | required documentation |

Types shared across tasks (defined in Task 2 and 3, reused verbatim):

```ts
// server/utils/collector.ts
export interface DiskMetric { mount: string; used: number; total: number }
export interface Metrics { cpuPercent: number; memUsed: number; memTotal: number; disks: DiskMetric[] }
// server/utils/range.ts
export type HistoryRange = '1h' | '24h' | '7d'
// server/utils/repository.ts
export interface HistoryPoint { ts: string; cpuPercent: number; memUsed: number; memTotal: number; disks: DiskMetric[] }
```

---

### Task 1: Infrastructure, schema and migrations

**Files:**
- Create: `docker-compose.yml`, `docker/init-db.sql`, `.env.example`, `drizzle.config.ts`, `vitest.config.ts`, `server/db/schema.ts`, `server/db/index.ts`, `server/db/migrate.ts`, `server/utils/log.ts`, `tests/db.test.ts`
- Modify: `package.json` (deps + scripts)

**Interfaces:**
- Produces: `createDb(url: string): { db: Db; pool: Pool }`, `getDb(): Db`, `type Db`, `runMigrations(db: Db): Promise<void>`, `samples`, `diskSamples` tables, `logInfo(msg, ctx?)`, `logError(msg, ctx?)`, `logDebug(msg, ctx?)`.

- [ ] **Step 1: Install dependencies**

```bash
npm install drizzle-orm pg systeminformation tailwindcss @tailwindcss/vite
npm install -D drizzle-kit vitest @types/pg
```

- [ ] **Step 2: Add scripts to `package.json`** (inside `"scripts"`)

```json
"test": "vitest run",
"db:up": "docker compose up -d",
"db:generate": "drizzle-kit generate"
```
Migrations run automatically when the server boots, so there is no separate migrate script.

- [ ] **Step 3: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:18
    container_name: computer-usage-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: computer-usage
    ports:
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql
      - ./docker/init-db.sql:/docker-entrypoint-initdb.d/init-db.sql:ro
volumes:
  pgdata:
```

`docker/init-db.sql`:
```sql
CREATE DATABASE "computer-usage-test";
```

`.env.example`:
```
DATABASE_URL=postgres://postgres:postgres@localhost:5433/computer-usage
SAMPLE_INTERVAL_MS=60000
NUXT_ADD_DEBUG_LOGS=false
```

Then: `cp .env.example .env && docker compose up -d`
Expected: container `computer-usage-db` running; `docker exec computer-usage-db psql -U postgres -l` lists `computer-usage` and `computer-usage-test`. (Init script only runs on first volume creation; if the test DB is missing run `docker compose down -v && docker compose up -d`.)

- [ ] **Step 4: Create `vitest.config.ts` and `drizzle.config.ts`**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'], fileParallelism: false }
})
```
```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/computer-usage' }
})
```

- [ ] **Step 5: Create `server/db/schema.ts`**

```ts
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
```

Run: `npx drizzle-kit generate` → creates `drizzle/0000_*.sql`.

- [ ] **Step 6: Create `server/utils/log.ts`, `server/db/index.ts`, `server/db/migrate.ts`**

```ts
// server/utils/log.ts
const debugOn = () => ['true', '1'].includes(process.env.NUXT_ADD_DEBUG_LOGS ?? '')
const fmt = (level: string, msg: string, ctx?: Record<string, unknown>) =>
  `[computer-usage] ${new Date().toISOString()} ${level} ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}`
export const logInfo = (msg: string, ctx?: Record<string, unknown>) => console.log(fmt('INFO', msg, ctx))
export const logError = (msg: string, ctx?: Record<string, unknown>) => console.error(fmt('ERROR', msg, ctx))
export const logDebug = (msg: string, ctx?: Record<string, unknown>) => { if (debugOn()) console.debug(fmt('DEBUG', msg, ctx)) }
```
```ts
// server/db/index.ts
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
```
```ts
// server/db/migrate.ts
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { join } from 'node:path'
import type { Db } from './index'

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') })
}
```

- [ ] **Step 7: Write the test `tests/db.test.ts`**

```ts
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
```

- [ ] **Step 8: Run** `npm test` → Expected: PASS (1 test). If it fails to connect, confirm `docker compose ps` shows the container healthy.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "config: add docker postgres, drizzle schema, migrations and logging"
```

---

### Task 2: Metrics collector

**Files:**
- Create: `server/utils/collector.ts`, `tests/collector.test.ts`

**Interfaces:**
- Produces: `DiskMetric`, `Metrics`, `normalizeDisks(raw)`, `toMetrics(load, mem, fs)`, `collectMetrics(): Promise<Metrics>`.

- [ ] **Step 1: Write the failing test `tests/collector.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { normalizeDisks, toMetrics } from '../server/utils/collector'

const fs = (fsName: string, mount: string, size: number, used: number) => ({ fs: fsName, mount, size, used })

describe('normalizeDisks', () => {
  it('drops duplicate devices, snap/loop mounts and zero-size filesystems', () => {
    const out = normalizeDisks([
      fs('/dev/sda1', '/', 100, 40),
      fs('/dev/sda1', '/var/lib/docker/bind', 100, 40),
      fs('/dev/loop3', '/snap/core/1', 50, 50),
      fs('/dev/nvme0n1p1', '/boot/efi', 0, 0),
      fs('/dev/sdb1', '/data', 200, 10)
    ])
    expect(out).toEqual([
      { mount: '/', used: 40, total: 100 },
      { mount: '/data', used: 10, total: 200 }
    ])
  })
})

describe('toMetrics', () => {
  it('maps values and rounds cpu to 1 decimal', () => {
    const m = toMetrics({ currentLoad: 12.345 }, { total: 1000, available: 400 }, [fs('/dev/sda1', '/', 100, 40)])
    expect(m).toEqual({ cpuPercent: 12.3, memUsed: 600, memTotal: 1000, disks: [{ mount: '/', used: 40, total: 100 }] })
  })
  it('never yields NaN/out-of-range cpu', () => {
    expect(toMetrics({ currentLoad: NaN }, { total: 1, available: 1 }, []).cpuPercent).toBe(0)
    expect(toMetrics({ currentLoad: 250 }, { total: 1, available: 1 }, []).cpuPercent).toBe(100)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/collector.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server/utils/collector.ts`**

```ts
import si from 'systeminformation'

export interface DiskMetric { mount: string; used: number; total: number }
export interface Metrics { cpuPercent: number; memUsed: number; memTotal: number; disks: DiskMetric[] }

interface RawFs { fs: string; mount: string; size: number; used: number }

export function normalizeDisks(raw: RawFs[]): DiskMetric[] {
  const seen = new Set<string>()
  const out: DiskMetric[] = []
  for (const d of raw) {
    if (!d.size || d.size <= 0) continue
    if (d.mount.startsWith('/snap/') || d.fs.startsWith('/dev/loop')) continue
    if (seen.has(d.fs)) continue
    seen.add(d.fs)
    out.push({ mount: d.mount, used: d.used, total: d.size })
  }
  return out
}

export function toMetrics(load: { currentLoad: number }, mem: { total: number; available: number }, fs: RawFs[]): Metrics {
  const cpu = Number.isFinite(load.currentLoad) ? Math.min(100, Math.max(0, load.currentLoad)) : 0
  return {
    cpuPercent: Math.round(cpu * 10) / 10,
    memUsed: mem.total - mem.available,
    memTotal: mem.total,
    disks: normalizeDisks(fs)
  }
}

export async function collectMetrics(): Promise<Metrics> {
  const [load, mem, fs] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize()])
  return toMetrics(load, mem, fs)
}
```

- [ ] **Step 4: Run** `npx vitest run tests/collector.test.ts` → Expected: PASS (3 tests).

- [ ] **Step 5: Smoke check real data**

Run: `npx tsx -e "import('./server/utils/collector.ts').then(m=>m.collectMetrics()).then(console.log)"`
Expected: object with plausible cpuPercent, memUsed < memTotal, non-empty `disks`.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: add system metrics collector"`

---

### Task 3: Repository and range parsing

**Files:**
- Create: `server/utils/range.ts`, `server/utils/repository.ts`, `tests/range.test.ts`, `tests/repository.test.ts`

**Interfaces:**
- Consumes: `Db`, `samples`, `diskSamples` (Task 1), `Metrics`, `DiskMetric` (Task 2).
- Produces: `HistoryRange`, `RANGE_MS`, `parseRange(v: unknown): HistoryRange | null`, `HistoryPoint`, `createRepository(db: Db)` → `{ saveSample(m: Metrics, ts?: Date): Promise<number>; getHistory(range: HistoryRange, now?: Date): Promise<HistoryPoint[]> }`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/range.test.ts
import { describe, expect, it } from 'vitest'
import { parseRange } from '../server/utils/range'

describe('parseRange', () => {
  it('defaults to 1h when missing', () => expect(parseRange(undefined)).toBe('1h'))
  it('accepts valid ranges', () => { expect(parseRange('24h')).toBe('24h'); expect(parseRange('7d')).toBe('7d') })
  it('returns null for invalid values', () => { expect(parseRange('1y')).toBeNull(); expect(parseRange(['1h'])).toBeNull() })
})
```
```ts
// tests/repository.test.ts
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
```

- [ ] **Step 2: Run** `npx vitest run tests/range.test.ts tests/repository.test.ts` → Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// server/utils/range.ts
export type HistoryRange = '1h' | '24h' | '7d'
export const RANGE_MS: Record<HistoryRange, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 }

export function parseRange(v: unknown): HistoryRange | null {
  if (v === undefined) return '1h'
  return typeof v === 'string' && v in RANGE_MS ? (v as HistoryRange) : null
}
```
```ts
// server/utils/repository.ts
import { asc, eq, gte } from 'drizzle-orm'
import type { Db } from '../db'
import { diskSamples, samples } from '../db/schema'
import type { DiskMetric, Metrics } from './collector'
import { RANGE_MS, type HistoryRange } from './range'
import { logDebug } from './log'

export interface HistoryPoint { ts: string; cpuPercent: number; memUsed: number; memTotal: number; disks: DiskMetric[] }

export function createRepository(db: Db) {
  return {
    async saveSample(m: Metrics, ts: Date = new Date()): Promise<number> {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(samples)
          .values({ ts, cpuPercent: m.cpuPercent, memUsed: m.memUsed, memTotal: m.memTotal })
          .returning({ id: samples.id })
        if (m.disks.length) {
          await tx.insert(diskSamples).values(m.disks.map(d => ({ sampleId: row.id, mount: d.mount, used: d.used, total: d.total })))
        }
        logDebug('sample saved', { id: row.id, disks: m.disks.length })
        return row.id
      })
    },

    async getHistory(range: HistoryRange, now: Date = new Date()): Promise<HistoryPoint[]> {
      const since = new Date(now.getTime() - RANGE_MS[range])
      const rows = await db.select({
        id: samples.id, ts: samples.ts, cpuPercent: samples.cpuPercent, memUsed: samples.memUsed, memTotal: samples.memTotal,
        mount: diskSamples.mount, used: diskSamples.used, total: diskSamples.total
      })
        .from(samples)
        .leftJoin(diskSamples, eq(diskSamples.sampleId, samples.id))
        .where(gte(samples.ts, since))
        .orderBy(asc(samples.ts), asc(samples.id), asc(diskSamples.id))
      const byId = new Map<number, HistoryPoint>()
      for (const r of rows) {
        let p = byId.get(r.id)
        if (!p) {
          p = { ts: r.ts.toISOString(), cpuPercent: r.cpuPercent, memUsed: r.memUsed, memTotal: r.memTotal, disks: [] }
          byId.set(r.id, p)
        }
        if (r.mount !== null) p.disks.push({ mount: r.mount, used: r.used!, total: r.total! })
      }
      return [...byId.values()]
    }
  }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/range.test.ts tests/repository.test.ts` → Expected: PASS (7 tests).

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: add metrics repository and range parsing"`

---

### Task 4: Overlap-safe tick and sampler plugin

**Files:**
- Create: `server/utils/sampler.ts`, `server/plugins/sampler.ts`, `tests/sampler.test.ts`

**Interfaces:**
- Consumes: `Metrics` (Task 2), `logInfo/logError/logDebug` (Task 1), `getDb`, `runMigrations`, `createRepository`, `collectMetrics`.
- Produces: `createTick(deps: { collect: () => Promise<Metrics>; save: (m: Metrics) => Promise<unknown> }): () => Promise<boolean>` (resolves `true` if a sample was saved, `false` if skipped/failed).

- [ ] **Step 1: Write failing test `tests/sampler.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createTick } from '../server/utils/sampler'

const metrics = { cpuPercent: 1, memUsed: 1, memTotal: 2, disks: [] }

describe('createTick', () => {
  it('collects then saves and returns true', async () => {
    const save = vi.fn().mockResolvedValue(1)
    const tick = createTick({ collect: async () => metrics, save })
    expect(await tick()).toBe(true)
    expect(save).toHaveBeenCalledWith(metrics)
  })
  it('returns false and does not throw when save fails; next tick still runs', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(1)
    const tick = createTick({ collect: async () => metrics, save })
    expect(await tick()).toBe(false)
    expect(await tick()).toBe(true)
  })
  it('returns false when collect throws', async () => {
    const tick = createTick({ collect: async () => { throw new Error('boom') }, save: vi.fn() })
    expect(await tick()).toBe(false)
  })
  it('skips a tick while the previous one is still running', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const save = vi.fn().mockResolvedValue(1)
    const tick = createTick({ collect: async () => { await gate; return metrics }, save })
    const first = tick()
    expect(await tick()).toBe(false)
    release()
    expect(await first).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/sampler.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement `server/utils/sampler.ts`**

```ts
import type { Metrics } from './collector'
import { logDebug, logError } from './log'

interface Deps { collect: () => Promise<Metrics>; save: (m: Metrics) => Promise<unknown> }

export function createTick({ collect, save }: Deps): () => Promise<boolean> {
  let running = false
  return async () => {
    if (running) { logDebug('tick skipped: previous still running'); return false }
    running = true
    const startedAt = Date.now()
    try {
      const m = await collect()
      logDebug('metrics collected', { cpu: m.cpuPercent, memUsed: m.memUsed, disks: m.disks.length })
      await save(m)
      logDebug('tick done', { ms: Date.now() - startedAt })
      return true
    } catch (err) {
      logError('sample tick failed', { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, at: new Date().toISOString() })
      return false
    } finally {
      running = false
    }
  }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/sampler.test.ts` → Expected: PASS (4 tests).

- [ ] **Step 5: Implement plugin `server/plugins/sampler.ts`**

```ts
import { getDb } from '../db'
import { runMigrations } from '../db/migrate'
import { collectMetrics } from '../utils/collector'
import { logError, logInfo } from '../utils/log'
import { createRepository } from '../utils/repository'
import { createTick } from '../utils/sampler'

const g = globalThis as { __computerUsageTimer?: NodeJS.Timeout }

export default defineNitroPlugin(async (nitroApp) => {
  if (g.__computerUsageTimer) clearInterval(g.__computerUsageTimer) // dev HMR safety

  const intervalMs = Number(process.env.SAMPLE_INTERVAL_MS) || 60_000
  try {
    const db = getDb()
    await runMigrations(db)
    const repo = createRepository(db)
    const tick = createTick({ collect: collectMetrics, save: m => repo.saveSample(m) })
    void tick()
    g.__computerUsageTimer = setInterval(() => void tick(), intervalMs)
    logInfo('sampler started', { intervalMs })
  } catch (err) {
    logError('sampler failed to start', { error: err instanceof Error ? err.message : String(err) })
  }

  nitroApp.hooks.hook('close', () => {
    if (g.__computerUsageTimer) clearInterval(g.__computerUsageTimer)
    g.__computerUsageTimer = undefined
  })
})
```

- [ ] **Step 6: Manual verification**

Run: `SAMPLE_INTERVAL_MS=5000 NUXT_ADD_DEBUG_LOGS=true npm run dev`, wait ~15 s.
Expected: log `sampler started`, repeated `sample saved`. Then:
`docker exec computer-usage-db psql -U postgres -d computer-usage -c "select count(*) from samples"` → count ≥ 2. Stop the server.

- [ ] **Step 7: Commit** `git add -A && git commit -m "feat: add 60s sampler plugin"`

---

### Task 5: API routes

**Files:**
- Create: `server/api/metrics/current.get.ts`, `server/api/metrics/history.get.ts`

**Interfaces:**
- Consumes: `collectMetrics`, `parseRange`, `createRepository`, `getDb`.
- Produces: `GET /api/metrics/current` → `Metrics & { ts: string }`; `GET /api/metrics/history?range=1h|24h|7d` → `HistoryPoint[]`; 400 on invalid range.

- [ ] **Step 1: Implement**

```ts
// server/api/metrics/current.get.ts
import { collectMetrics } from '../../utils/collector'
import { logError } from '../../utils/log'

export default defineEventHandler(async () => {
  try {
    return { ts: new Date().toISOString(), ...(await collectMetrics()) }
  } catch (err) {
    logError('current metrics failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read system metrics' })
  }
})
```
```ts
// server/api/metrics/history.get.ts
import { getDb } from '../../db'
import { logDebug, logError } from '../../utils/log'
import { parseRange } from '../../utils/range'
import { createRepository } from '../../utils/repository'

export default defineEventHandler(async (event) => {
  const raw = getQuery(event).range
  const range = parseRange(raw)
  if (!range) throw createError({ statusCode: 400, statusMessage: 'range must be one of 1h, 24h, 7d' })
  try {
    const rows = await createRepository(getDb()).getHistory(range)
    logDebug('history served', { range, rows: rows.length })
    return rows
  } catch (err) {
    logError('history query failed', { range, error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read history' })
  }
})
```

- [ ] **Step 2: Verify** (with `npm run dev` running)

```bash
curl -s localhost:3000/api/metrics/current
curl -s "localhost:3000/api/metrics/history?range=1h" | head -c 300
curl -s -o /dev/null -w "%{http_code}\n" "localhost:3000/api/metrics/history?range=1y"
```
Expected: JSON with cpu/mem/disks; JSON array of points; `400`.

- [ ] **Step 3: Commit** `git add -A && git commit -m "feat: add metrics API routes"`

---

### Task 6: Dashboard

**Files:**
- Create: `app/assets/css/main.css`, `app/components/GaugeBar.vue`, `app/components/UsageChart.vue`
- Modify: `nuxt.config.ts`, `app/app.vue`, create `app/pages/index.vue`

**Interfaces:**
- Consumes: `/api/metrics/current`, `/api/metrics/history` (Task 5).
- Produces: `GaugeBar` props `{ label: string; percent: number; detail?: string }`; `UsageChart` props `{ title: string; points: { ts: string; value: number }[] }`.

- [ ] **Step 1: Config**

```ts
// nuxt.config.ts
import tailwindcss from '@tailwindcss/vite'
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] }
})
```
`app/assets/css/main.css`: `@import "tailwindcss";`

`app/app.vue`:
```vue
<template>
  <div>
    <NuxtRouteAnnouncer />
    <NuxtPage />
  </div>
</template>
```

- [ ] **Step 2: Components**

```vue
<!-- app/components/GaugeBar.vue -->
<script setup lang="ts">
const props = defineProps<{ label: string; percent: number; detail?: string }>()
const pct = computed(() => Math.min(100, Math.max(0, props.percent)))
const color = computed(() => pct.value >= 90 ? 'bg-red-500' : pct.value >= 70 ? 'bg-amber-500' : 'bg-emerald-500')
</script>
<template>
  <div>
    <div class="flex justify-between text-sm">
      <span class="font-medium">{{ label }}</span>
      <span>{{ pct.toFixed(1) }}% <span v-if="detail" class="text-slate-500">· {{ detail }}</span></span>
    </div>
    <div class="mt-1 h-3 w-full overflow-hidden rounded bg-slate-200">
      <div class="h-full transition-all" :class="color" :style="{ width: pct + '%' }" />
    </div>
  </div>
</template>
```
```vue
<!-- app/components/UsageChart.vue -->
<script setup lang="ts">
const props = defineProps<{ title: string; points: { ts: string; value: number }[] }>()
const W = 600, H = 120
const path = computed(() => {
  const p = props.points
  if (p.length < 2) return ''
  const t0 = new Date(p[0]!.ts).getTime()
  const span = new Date(p[p.length - 1]!.ts).getTime() - t0 || 1
  return p.map((pt, i) => `${i ? 'L' : 'M'}${(((new Date(pt.ts).getTime() - t0) / span) * W).toFixed(1)},${(H - (Math.min(100, Math.max(0, pt.value)) / 100) * H).toFixed(1)}`).join(' ')
})
</script>
<template>
  <div class="rounded border border-slate-200 bg-white p-3">
    <h3 class="mb-2 text-sm font-semibold">{{ title }}</h3>
    <svg v-if="path" :viewBox="`0 0 ${W} ${H}`" class="h-28 w-full" preserveAspectRatio="none">
      <path :d="path" fill="none" stroke="currentColor" stroke-width="2" class="text-sky-600" vector-effect="non-scaling-stroke" />
    </svg>
    <p v-else class="py-8 text-center text-sm text-slate-500">Not enough data yet — samples are taken every minute.</p>
  </div>
</template>
```

- [ ] **Step 3: Page `app/pages/index.vue`**

```vue
<script setup lang="ts">
type Disk = { mount: string; used: number; total: number }
type Current = { ts: string; cpuPercent: number; memUsed: number; memTotal: number; disks: Disk[] }
type Point = { ts: string; cpuPercent: number; memUsed: number; memTotal: number; disks: Disk[] }

const range = ref<'1h' | '24h' | '7d'>('1h')
const { data: current, error: currentError, refresh: refreshCurrent } = await useFetch<Current>('/api/metrics/current')
const { data: history, refresh: refreshHistory } = await useFetch<Point[]>('/api/metrics/history', { query: { range } })

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { refreshCurrent(); refreshHistory() }, 60_000) })
onBeforeUnmount(() => clearInterval(timer))

const gb = (b: number) => (b / 1024 ** 3).toFixed(1) + ' GB'
const pct = (u: number, t: number) => (t ? (u / t) * 100 : 0)
const cpuPoints = computed(() => (history.value ?? []).map(p => ({ ts: p.ts, value: p.cpuPercent })))
const memPoints = computed(() => (history.value ?? []).map(p => ({ ts: p.ts, value: pct(p.memUsed, p.memTotal) })))
const diskPoints = computed(() => (history.value ?? []).map(p => ({ ts: p.ts, value: pct(p.disks[0]?.used ?? 0, p.disks[0]?.total ?? 0) })))
</script>

<template>
  <main class="mx-auto max-w-4xl space-y-6 p-4">
    <h1 class="text-2xl font-bold">Computer usage</h1>
    <p v-if="currentError" class="rounded bg-red-50 p-3 text-red-700">Could not read system metrics.</p>
    <section v-else-if="current" class="space-y-3 rounded border border-slate-200 bg-white p-4">
      <GaugeBar label="CPU" :percent="current.cpuPercent" />
      <GaugeBar label="Memory" :percent="pct(current.memUsed, current.memTotal)" :detail="`${gb(current.memUsed)} / ${gb(current.memTotal)}`" />
      <GaugeBar v-for="d in current.disks" :key="d.mount" :label="`Disk ${d.mount}`" :percent="pct(d.used, d.total)" :detail="`${gb(d.used)} / ${gb(d.total)}`" />
    </section>

    <section class="space-y-3">
      <div class="flex gap-2">
        <button v-for="r in (['1h', '24h', '7d'] as const)" :key="r" class="rounded px-3 py-1 text-sm" :class="range === r ? 'bg-sky-600 text-white' : 'bg-slate-200'" @click="range = r">{{ r }}</button>
      </div>
      <UsageChart title="CPU %" :points="cpuPoints" />
      <UsageChart title="Memory %" :points="memPoints" />
      <UsageChart :title="`Disk % (${current?.disks[0]?.mount ?? 'first disk'})`" :points="diskPoints" />
    </section>
  </main>
</template>
```

- [ ] **Step 4: Verify in browser**

Run `npm run dev`, open http://localhost:3000. Expected: gauges for CPU, memory and each disk; charts show the empty-state message until ≥2 samples exist, then draw lines; range buttons switch data; after 1 minute values refresh.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: add usage dashboard"`

---

### Task 7: Documentation

**Files:**
- Create: `docs/user-guides/config.md`, `docs/user-guides/manual.md`, `docs/user-guides/features.md`, `docs/pending-tasks.md`, `../docs/architecture/adrs/0006-computer-usage-in-process-sampler.md`
- Modify: `../docs/architecture/{business,data,application,technology}-architecture.md`, `README.md`

- [ ] **Step 1: `config.md`** — table of `DATABASE_URL`, `TEST_DATABASE_URL`, `SAMPLE_INTERVAL_MS`, `NUXT_ADD_DEBUG_LOGS` with defaults; Docker note (port 5433, `docker compose up -d`, `down -v` to re-run init script).

- [ ] **Step 2: `manual.md`** — step-by-step: start DB, `cp .env.example .env`, `npm run dev`, open dashboard, read gauges, switch ranges, query data with `psql`; include a mermaid `sequenceDiagram` (Timer → Collector → Repository → Postgres; Browser → API → Postgres).

- [ ] **Step 3: `features.md`** — bullet list: 60s sampling, CPU/memory/multi-disk, Postgres history, live gauges, 1h/24h/7d charts, failure-tolerant sampler, debug logging.

- [ ] **Step 4: `pending-tasks.md`** — for each: description, value, consequence of not doing it:
  1. Data retention/pruning (table grows ~1,440 rows/day; unbounded disk use).
  2. Multi-machine support.
  3. Alerting/thresholds.
  4. Downsampling for the 7d chart (~10k points per request).
  5. Running the app itself in Docker (host disk view requires mounts).
  6. Per-disk history selection in the dashboard (only the first disk is charted).

- [ ] **Step 5: ADR `0006-computer-usage-in-process-sampler.md`** — Context (local monitor, 1 min cadence), Decision (in-process Nitro plugin timer vs separate collector), Consequences (single deployable; sampling stops when app is down; app runs on host, only Postgres in Docker).

- [ ] **Step 6: Architecture diagrams** — append a `computer-usage` section to each of the four PlantUML docs (business: actor "Operator" → monitor capability; data: `samples`/`disk_samples` ER; application: plugin/collector/repository/API/dashboard components; technology: Nuxt 4 on host, systeminformation, Postgres 18 container on :5433).

- [ ] **Step 7: Replace the scaffold `README.md`** with a 10-line quick start pointing to `docs/user-guides/`.

- [ ] **Step 8: Final verification** — run `npm test` (all pass) and `npm run build` (succeeds).

- [ ] **Step 9: Commit** `git add -A && git commit -m "docs: add user guides, pending tasks, ADR and architecture diagrams"` (the `../docs/architecture` files live outside this repo; leave them uncommitted and tell the user).
