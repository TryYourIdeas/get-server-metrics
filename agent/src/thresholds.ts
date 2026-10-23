import type { EventKind, Reading, UsageEvent } from './protocol'

export interface Thresholds { cpuPercent: number; cpuConsecutive: number; memoryPercent: number; diskPercent: number }
export const DEFAULT_THRESHOLDS: Thresholds = { cpuPercent: 90, cpuConsecutive: 3, memoryPercent: 90, diskPercent: 90 }

const round1 = (n: number) => Math.round(n * 10) / 10
const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0)

/**
 * Turns successive readings into alert/ok events, emitting only on state changes.
 * CPU needs `cpuConsecutive` checks in a row at or above the threshold; memory and disk alert on the first.
 * A mount that vanishes while alerting emits an `ok` so the alert can clear.
 */
export function createThresholdEvaluator(t: Thresholds): (r: Reading) => UsageEvent[] {
  let cpuStreak = 0
  let cpuAlert = false
  let memAlert = false
  const diskAlert = new Map<string, boolean>()

  return (r) => {
    const out: UsageEvent[] = []
    const event = (kind: EventKind, state: 'alert' | 'ok', value: number, threshold: number, mount?: string): UsageEvent =>
      ({ kind, state, value: round1(value), threshold, ts: r.ts, ...(mount ? { mount } : {}) })

    cpuStreak = r.cpuPercent >= t.cpuPercent ? cpuStreak + 1 : 0
    if (!cpuAlert && cpuStreak >= t.cpuConsecutive) {
      cpuAlert = true
      out.push(event('cpu', 'alert', r.cpuPercent, t.cpuPercent))
    } else if (cpuAlert && r.cpuPercent < t.cpuPercent) {
      cpuAlert = false
      out.push(event('cpu', 'ok', r.cpuPercent, t.cpuPercent))
    }

    const mem = pct(r.memUsed, r.memTotal)
    if (r.memTotal > 0) {
      if (!memAlert && mem >= t.memoryPercent) {
        memAlert = true
        out.push(event('memory', 'alert', mem, t.memoryPercent))
      } else if (memAlert && mem < t.memoryPercent) {
        memAlert = false
        out.push(event('memory', 'ok', mem, t.memoryPercent))
      }
    }

    const seen = new Set<string>()
    for (const d of r.disks) {
      seen.add(d.mount)
      const p = pct(d.used, d.total)
      const was = diskAlert.get(d.mount) ?? false
      if (!was && p >= t.diskPercent) {
        diskAlert.set(d.mount, true)
        out.push(event('disk', 'alert', p, t.diskPercent, d.mount))
      } else if (was && p < t.diskPercent) {
        diskAlert.set(d.mount, false)
        out.push(event('disk', 'ok', p, t.diskPercent, d.mount))
      }
    }
    for (const [mount, was] of diskAlert) {
      if (seen.has(mount)) continue
      if (was) out.push(event('disk', 'ok', 0, t.diskPercent, mount))
      diskAlert.delete(mount)
    }
    return out
  }
}
