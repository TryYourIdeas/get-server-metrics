import { getDb } from '../db'
import { runMigrations } from '../db/migrate'
import { collectMetrics } from '../utils/collector'
import { logError, logInfo } from '../utils/log'
import { createRepository } from '../utils/repository'
import { createTick } from '../utils/sampler'

const g = globalThis as { __computerUsageTimer?: NodeJS.Timeout }

export default defineNitroPlugin(async (nitroApp) => {
  if (g.__computerUsageTimer) clearInterval(g.__computerUsageTimer) // dev HMR safety

  const intervalMs = Number(process.env.SAMPLE_INTERVAL_MS) || 60_000
  try {
    const db = getDb()
    await runMigrations(db)
    const repo = createRepository(db)
    const tick = createTick({ collect: collectMetrics, save: m => repo.saveSample(m) })
    void tick()
    g.__computerUsageTimer = setInterval(() => void tick(), intervalMs)
    logInfo('sampler started', { intervalMs })
  } catch (err) {
    logError('sampler failed to start', { error: err instanceof Error ? err.message : String(err) })
  }

  nitroApp.hooks.hook('close', () => {
    if (g.__computerUsageTimer) clearInterval(g.__computerUsageTimer)
    g.__computerUsageTimer = undefined
  })
})
