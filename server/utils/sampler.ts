import type { Metrics } from './collector'
import { logDebug, logError } from './log'

interface Deps {
  /** Runs before each collection (e.g. migrations); a rejection skips the tick and is retried on the next one. */
  ensureReady?: () => Promise<void>
  collect: () => Promise<Metrics>
  save: (m: Metrics) => Promise<unknown>
}

/** Runs `fn` until it succeeds once; concurrent callers share the in-flight run, failures are not cached. */
export function memoizeUntilFailure(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    pending ??= fn().catch((err) => { pending = undefined; throw err })
    return pending
  }
}

export function createTick({ ensureReady, collect, save }: Deps): () => Promise<boolean> {
  let running = false
  return async () => {
    if (running) { logDebug('tick skipped: previous still running'); return false }
    running = true
    const startedAt = Date.now()
    try {
      await ensureReady?.()
      const m = await collect()
      logDebug('metrics collected', { cpu: m.cpuPercent, memUsed: m.memUsed, disks: m.disks.length })
      await save(m)
      logDebug('tick done', { ms: Date.now() - startedAt })
      return true
    } catch (err) {
      logError('sample tick failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        at: new Date().toISOString()
      })
      return false
    } finally {
      running = false
    }
  }
}
