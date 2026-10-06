import { logDebug, logError, logInfo } from './log'

export const DEFAULT_RETENTION_DAYS = 30
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Reads RETENTION_DAYS: unset/invalid falls back to the default, `0` disables pruning. */
export function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETENTION_DAYS
}

interface Deps {
  retentionDays: number
  /** Runs before each prune (e.g. migrations); a rejection skips the run and is retried at the next interval. */
  ensureReady?: () => Promise<void>
  prune: (cutoff: Date) => Promise<number>
  now?: () => Date
}

/** Deletes samples older than the retention window. Returns the number deleted, or `undefined` when disabled or failed. */
export function createPruner({ retentionDays, ensureReady, prune, now = () => new Date() }: Deps): () => Promise<number | undefined> {
  return async () => {
    if (retentionDays <= 0) { logDebug('prune skipped: retention disabled'); return undefined }
    const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000)
    try {
      await ensureReady?.()
      const deleted = await prune(cutoff)
      logInfo('old samples pruned', { deleted, cutoff: cutoff.toISOString(), retentionDays })
      return deleted
    } catch (err) {
      logError('prune failed', { cutoff: cutoff.toISOString(), retentionDays, error: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }
}
