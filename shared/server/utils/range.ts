export type HistoryRange = '1h' | '24h' | '7d'
export const RANGE_MS: Record<HistoryRange, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 }

export function parseRange(v: unknown): HistoryRange | null {
  if (v === undefined) return '1h'
  return typeof v === 'string' && Object.hasOwn(RANGE_MS, v) ? (v as HistoryRange) : null
}
