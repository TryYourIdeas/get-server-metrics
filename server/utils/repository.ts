import { and, asc, desc, eq, gte, lt, type SQL } from 'drizzle-orm'
import type { DiskReading, Reading, UsageEvent } from 'computer-usage-agent/protocol'
import type { Db } from '../db'
import { diskSamples, events, hosts, samples } from '../db/schema'
import { logDebug } from './log'
import { RANGE_MS, type HistoryRange } from './range'

export type HistoryPoint = Reading
export interface HostRow { hostId: string; online: boolean; lastSeen: string }

export function createRepository(db: Db) {
  const selectPoints = (where: SQL | undefined) => db.select({
    id: samples.id, ts: samples.ts, cpuPercent: samples.cpuPercent, memUsed: samples.memUsed, memTotal: samples.memTotal,
    mount: diskSamples.mount, used: diskSamples.used, total: diskSamples.total
  })
    .from(samples)
    .leftJoin(diskSamples, eq(diskSamples.sampleId, samples.id))
    .where(where)
    .orderBy(asc(samples.ts), asc(samples.id), asc(diskSamples.id))

  async function pointsWhere(where: SQL | undefined): Promise<HistoryPoint[]> {
    const rows = await selectPoints(where)
    const byId = new Map<number, HistoryPoint>()
    for (const r of rows) {
      let p = byId.get(r.id)
      if (!p) {
        p = { ts: r.ts.toISOString(), cpuPercent: r.cpuPercent, memUsed: r.memUsed, memTotal: r.memTotal, disks: [] as DiskReading[] }
        byId.set(r.id, p)
      }
      if (r.mount !== null) p.disks.push({ mount: r.mount, used: r.used!, total: r.total! })
    }
    return [...byId.values()]
  }

  return {
    /** Stores a reading and its disks. Returns the new id, or null when this (host, ts) was already stored. */
    async saveSample(hostId: string, r: Reading): Promise<number | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(samples)
          .values({ hostId, ts: new Date(r.ts), cpuPercent: r.cpuPercent, memUsed: r.memUsed, memTotal: r.memTotal })
          .onConflictDoNothing({ target: [samples.hostId, samples.ts] })
          .returning({ id: samples.id })
        if (!row) { logDebug('duplicate sample ignored', { hostId, ts: r.ts }); return null }
        if (r.disks.length) {
          await tx.insert(diskSamples).values(r.disks.map(d => ({ sampleId: row.id, mount: d.mount, used: d.used, total: d.total })))
        }
        logDebug('sample saved', { id: row.id, hostId, disks: r.disks.length })
        return row.id
      })
    },

    /** Stores an alert/ok event. Returns false when the same event was already stored. */
    async saveEvent(hostId: string, e: UsageEvent): Promise<boolean> {
      const rows = await db.insert(events)
        .values({ hostId, ts: new Date(e.ts), kind: e.kind, state: e.state, value: e.value, threshold: e.threshold, mount: e.mount ?? '' })
        .onConflictDoNothing()
        .returning({ id: events.id })
      logDebug(rows.length ? 'event saved' : 'duplicate event ignored', { hostId, kind: e.kind, state: e.state })
      return rows.length > 0
    },

    async touchHost(hostId: string, opts: { online?: boolean } = {}, now: Date = new Date()): Promise<void> {
      await db.insert(hosts)
        .values({ hostId, online: opts.online ?? false, lastSeen: now })
        .onConflictDoUpdate({
          target: hosts.hostId,
          set: { lastSeen: now, ...(opts.online === undefined ? {} : { online: opts.online }) }
        })
    },

    async listHosts(): Promise<HostRow[]> {
      const rows = await db.select().from(hosts).orderBy(asc(hosts.hostId))
      return rows.map(h => ({ hostId: h.hostId, online: h.online, lastSeen: h.lastSeen.toISOString() }))
    },

    async getHistory(hostId: string, range: HistoryRange, now: Date = new Date()): Promise<HistoryPoint[]> {
      const since = new Date(now.getTime() - RANGE_MS[range])
      return pointsWhere(and(eq(samples.hostId, hostId), gte(samples.ts, since)))
    },

    async getLatest(hostId: string): Promise<HistoryPoint | null> {
      const [latest] = await db.select({ id: samples.id }).from(samples).where(eq(samples.hostId, hostId)).orderBy(desc(samples.ts)).limit(1)
      if (!latest) return null
      return (await pointsWhere(eq(samples.id, latest.id)))[0] ?? null
    },

    async getRecentEvents(hostId: string, limit = 20): Promise<UsageEvent[]> {
      const rows = await db.select().from(events).where(eq(events.hostId, hostId)).orderBy(desc(events.ts), desc(events.id)).limit(limit)
      return rows.map(r => ({
        kind: r.kind as UsageEvent['kind'], state: r.state as UsageEvent['state'], value: r.value, threshold: r.threshold,
        ts: r.ts.toISOString(), ...(r.mount ? { mount: r.mount } : {})
      }))
    },

    async deleteHostLogs(hostId: string): Promise<{ samples: number; events: number }> {
      return db.transaction(async tx => {
        const deletedSamples = await tx.delete(samples).where(eq(samples.hostId, hostId)).returning({ id: samples.id })
        const deletedEvents = await tx.delete(events).where(eq(events.hostId, hostId)).returning({ id: events.id })
        const deleted = { samples: deletedSamples.length, events: deletedEvents.length }
        logDebug('host logs deleted', { hostId, ...deleted })
        return deleted
      })
    },

    /** Deletes samples older than `cutoff` (their disk rows cascade) and returns how many samples were removed. */
    async pruneOlderThan(cutoff: Date): Promise<number> {
      const deleted = await db.delete(samples).where(lt(samples.ts, cutoff)).returning({ id: samples.id })
      logDebug('samples pruned', { cutoff: cutoff.toISOString(), deleted: deleted.length })
      return deleted.length
    },

    async pruneEventsOlderThan(cutoff: Date): Promise<number> {
      const deleted = await db.delete(events).where(lt(events.ts, cutoff)).returning({ id: events.id })
      logDebug('events pruned', { cutoff: cutoff.toISOString(), deleted: deleted.length })
      return deleted.length
    }
  }
}
