import { asc, eq, gte, lt } from 'drizzle-orm'
import type { Db } from '../db'
import { diskSamples, samples } from '../db/schema'
import type { DiskMetric, Metrics } from './collector'
import { logDebug } from './log'
import { RANGE_MS, type HistoryRange } from './range'

export interface HistoryPoint { ts: string; cpuPercent: number; memUsed: number; memTotal: number; disks: DiskMetric[] }

export function createRepository(db: Db) {
  return {
    async saveSample(m: Metrics, ts: Date = new Date()): Promise<number> {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(samples)
          .values({ ts, cpuPercent: m.cpuPercent, memUsed: m.memUsed, memTotal: m.memTotal })
          .returning({ id: samples.id })
        if (m.disks.length) {
          await tx.insert(diskSamples).values(m.disks.map(d => ({ sampleId: row!.id, mount: d.mount, used: d.used, total: d.total })))
        }
        logDebug('sample saved', { id: row!.id, disks: m.disks.length })
        return row!.id
      })
    },

    /** Deletes samples older than `cutoff` (their disk rows cascade) and returns how many samples were removed. */
    async pruneOlderThan(cutoff: Date): Promise<number> {
      const deleted = await db.delete(samples).where(lt(samples.ts, cutoff)).returning({ id: samples.id })
      logDebug('samples pruned', { cutoff: cutoff.toISOString(), deleted: deleted.length })
      return deleted.length
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
