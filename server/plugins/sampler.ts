import { getDb } from '../db'
import { runMigrations } from '../db/migrate'
import { collectMetrics } from '../utils/collector'
import { logInfo } from '../utils/log'
import { createRepository } from '../utils/repository'
import { createTick, memoizeUntilFailure } from '../utils/sampler'

const g = globalThis as { __computerUsageTimer?: NodeJS.Timeout }

export default defineNitroPlugin((nitroApp) => {
  if (g.__computerUsageTimer) clearInterval(g.__computerUsageTimer) // dev HMR safety

  const intervalMs = Number(process.env.SAMPLE_INTERVAL_MS) || 60_000
  const db = getDb()
  const repo = createRepository(db)
  // Migrations are retried on every tick until they succeed, so starting the app before Postgres is up self-heals.
  const tick = createTick({
    ensureReady: memoizeUntilFailure(() => runMigrations(db)),
    collect: collectMetrics,
    save: m => repo.saveSample(m)
  })
  void tick()
  g.__computerUsageTimer = setInterval(() => void tick(), intervalMs)
  logInfo('sampler started', { intervalMs })

  nitroApp.hooks.hook('close', () => {
    if (g.__computerUsageTimer) clearInterval(g.__computerUsageTimer)
    g.__computerUsageTimer = undefined
  })
})
