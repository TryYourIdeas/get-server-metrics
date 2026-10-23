import si from 'systeminformation'
import type { DiskReading, Reading } from './protocol'

export type Metrics = Omit<Reading, 'ts'>

interface RawFs { fs: string; mount: string; size: number; used: number }

const PSEUDO_MOUNT_PREFIXES = ['/sys/', '/proc/', '/dev/']
const VIRTUAL_FS_NAMES = new Set(['efivarfs', 'overlay', 'nsfs'])

export function normalizeDisks(raw: RawFs[]): DiskReading[] {
  const seen = new Set<string>()
  const out: DiskReading[] = []
  for (const d of raw) {
    if (!d.size || d.size <= 0) continue
    if (d.mount.startsWith('/snap/') || d.fs.startsWith('/dev/loop')) continue
    if (VIRTUAL_FS_NAMES.has(d.fs)) continue
    if (PSEUDO_MOUNT_PREFIXES.some(p => d.mount.startsWith(p))) continue
    if (d.mount.startsWith('/run/') && !d.mount.startsWith('/run/media/')) continue // keep removable disks
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

export async function collectReading(now: Date = new Date()): Promise<Reading> {
  const [load, mem, fs] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize()])
  return { ts: now.toISOString(), ...toMetrics(load, mem, fs) }
}
