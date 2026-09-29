export interface DiskUsage { mount: string; used: number; total: number }

/** Usage % over time for one mount; samples lacking that mount are skipped so disk order changes cannot mix disks up. */
export function diskSeries(points: { ts: string; disks: DiskUsage[] }[], mount: string | undefined): { ts: string; value: number }[] {
  if (!mount) return []
  const out: { ts: string; value: number }[] = []
  for (const p of points) {
    const d = p.disks.find(x => x.mount === mount)
    if (d && d.total) out.push({ ts: p.ts, value: (d.used / d.total) * 100 })
  }
  return out
}
