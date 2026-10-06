import { getDb } from '../db'
import { runMigrations } from '../db/migrate'
import { collectMetrics } from '../utils/collector'
import { logInfo } from '../utils/log'
import { createRepository } from '../utils/repository'
import { createPruner, parseRetentionDays, PRUNE_INTERVAL_MS } from '../utils/retention'
import { createTick, memoizeUntilFailure } from '../utils/sampler'

const g = globalThis as { __computerUsageTimer?: NodeJS.Timeout; __computerUsagePruneTimer?: NodeJS.Timeout }

export default defineNitroPlugin((nitroApp) => {
  if (g.__computerUsageTimer) clearInterval(g.__computerUsageTimer) // dev HMR safety
  if (g.__computerUsagePruneTimer) clearInterval(g.__computerUsagePruneTimer)

  const intervalMs = Number(process.env.SAMPLE_INTERVAL_MS) || 60_000
  const db = getDb()
  const repo = createRepository(db)
  // Migrations are retried on every tick until they succeed, so starting the app before Postgres is up self-heals.
  const ensureReady = memoizeUntilFailure(() => runMigrations(db))
  const tick = createTick({
    ensureReady,
    collect: collectMetrics,
    save: m => repo.saveSample(m)
  })
  void tick()
  g.__computerUsageTimer = setInterval(() => void tick(), intervalMs)
  logInfo('sampler started', { intervalMs })

  // Pruning runs on its own daily timer so a slow delete never delays sampling.
  const retentionDays = parseRetentionDays(process.env.RETENTION_DAYS)
  const prune = createPruner({ retentionDays, ensureReady, prune: cutoff => repo.pruneOlderThan(cutoff) })
  void prune()
  g.__computerUsagePruneTimer = setInterval(() => void prune(), PRUNE_INTERVAL_MS)
  logInfo('retention configured', { retentionDays, enabled: retentionDays > 0 })

  nitroApp.hooks.hook('close', () => {
    if (g.__computerUsageTimer) clearInterval(g.__computerUsageTimer)
    g.__computerUsageTimer = undefined
    if (g.__computerUsagePruneTimer) clearInterval(g.__computerUsagePruneTimer)
    g.__computerUsagePruneTimer = undefined
  })
})
