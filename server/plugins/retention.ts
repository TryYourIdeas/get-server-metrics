import { getDb } from '../db'
import { logInfo } from '../utils/log'
import { ensureDbReady } from '../utils/ready'
import { createRepository } from '../utils/repository'
import { createPruner, parseRetentionDays, PRUNE_INTERVAL_MS } from '../utils/retention'

const g = globalThis as { __computerUsagePruneTimer?: NodeJS.Timeout }

export default defineNitroPlugin((nitroApp) => {
  if (g.__computerUsagePruneTimer) clearInterval(g.__computerUsagePruneTimer) // dev HMR safety

  const repo = createRepository(getDb())
  const retentionDays = parseRetentionDays(process.env.RETENTION_DAYS)
  const prune = createPruner({
    retentionDays,
    ensureReady: ensureDbReady,
    prune: async (cutoff) => {
      const samples = await repo.pruneOlderThan(cutoff)
      await repo.pruneEventsOlderThan(cutoff)
      return samples
    }
  })
  void prune()
  g.__computerUsagePruneTimer = setInterval(() => void prune(), PRUNE_INTERVAL_MS)
  logInfo('retention configured', { retentionDays, enabled: retentionDays > 0 })

  nitroApp.hooks.hook('close', () => {
    if (g.__computerUsagePruneTimer) clearInterval(g.__computerUsagePruneTimer)
    g.__computerUsagePruneTimer = undefined
  })
})
