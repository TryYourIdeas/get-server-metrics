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

/** Appends a live sample to the in-memory buffer, keeping only the newest `max`; samples not newer than the last are ignored. */
export function appendLive<T extends { ts: string }>(buf: T[], point: T, max: number): T[] {
  const last = buf[buf.length - 1]
  if (last && new Date(point.ts).getTime() <= new Date(last.ts).getTime()) return buf
  const next = [...buf, point]
  return next.length > max ? next.slice(next.length - max) : next
}

/** Stored history followed by the live samples taken after its last row, so the two never overlap. */
export function withLive<T extends { ts: string }>(history: T[], live: T[]): T[] {
  const last = history[history.length - 1]
  if (!last) return live
  const t = new Date(last.ts).getTime()
  return [...history, ...live.filter(p => new Date(p.ts).getTime() > t)]
}

export const formatBytes = (b: number) => (b / 1024 ** 3).toFixed(1) + ' GB'

/** Y-axis tick text: the percentage, plus the real size it represents when the total is known. */
export function axisLabel(percent: number, total?: number): string {
  return total ? `${percent}% · ${formatBytes((percent / 100) * total)}` : `${percent}%`
}

/** Current reading for a chart title, e.g. "8.0 GB / 31.0 GB (26%)" or "12%" for CPU. */
export function latestLabel(percent: number, total?: number): string {
  const pct = Math.round(percent)
  return total ? `${formatBytes((percent / 100) * total)} / ${formatBytes(total)} (${pct}%)` : `${pct}%`
}
