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
