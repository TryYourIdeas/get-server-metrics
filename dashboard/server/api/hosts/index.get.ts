import { getDb } from '../../../../shared/server/db'
import { logError } from '../../../../shared/server/utils/log'
import { eventMonitorHeaders, eventMonitorUrl } from '../../utils/event-monitor'
import { createRepository } from '../../../../shared/server/utils/repository'

export default defineEventHandler(async () => {
  try {
    const hosts = await createRepository(getDb()).listHosts()
    const health = await fetch(eventMonitorUrl('/health'), { headers: eventMonitorHeaders(), signal: AbortSignal.timeout(3000) })
    if (!health.ok) throw new Error(`event monitor returned HTTP ${health.status}`)
    const monitor = await health.json() as { brokerConnected: boolean; staleAfterMs: number }
    return { hosts, brokerConnected: monitor.brokerConnected, staleAfterMs: monitor.staleAfterMs }
  } catch (err) {
    logError('hosts query or event monitor health check failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 503, statusMessage: 'Could not read hosts or event monitor status' })
  }
})
