import { collectMetrics } from '../../utils/collector'
import { logError } from '../../utils/log'

export default defineEventHandler(async () => {
  try {
    return { ts: new Date().toISOString(), ...(await collectMetrics()) }
  } catch (err) {
    logError('current metrics failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read system metrics' })
  }
})
