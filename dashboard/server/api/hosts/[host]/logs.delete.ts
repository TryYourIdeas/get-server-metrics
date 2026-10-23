import { isValidHostId } from 'agent/protocol'
import { eventMonitorHeaders, eventMonitorUrl } from '../../../utils/event-monitor'
import { logError } from '../../../../../shared/server/utils/log'

export default defineEventHandler(async (event) => {
  const host = getRouterParam(event, 'host')
  if (!isValidHostId(host)) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })

  try {
    const response = await fetch(eventMonitorUrl(`/hosts/${encodeURIComponent(host)}/logs`), {
      method: 'DELETE',
      headers: eventMonitorHeaders(),
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) throw new Error(`event monitor returned HTTP ${response.status}`)
    return await response.json()
  } catch (err) {
    logError('event monitor log deletion failed', { host, error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 503, statusMessage: 'Could not delete host logs through the event monitor' })
  }
})
