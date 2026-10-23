import { isValidHostId } from 'agent/protocol'
import { eventMonitorHeaders, eventMonitorUrl } from '../../../utils/event-monitor'
import { logError } from '../../../../../shared/server/utils/log'

export default defineEventHandler(async (event) => {
  const host = getRouterParam(event, 'host')
  if (!isValidHostId(host)) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
  try {
    const response = await fetch(eventMonitorUrl(`/hosts/${encodeURIComponent(host)}/check`), {
      method: 'POST',
      headers: eventMonitorHeaders(),
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) {
      throw createError({
        statusCode: response.status,
        statusMessage: response.status === 503 ? 'MQTT broker is not connected'
          : response.status === 429 ? 'Check requested too recently'
            : 'Could not send the check request'
      })
    }
    return await response.json()
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
    logError('event monitor check request failed', { host, error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 502, statusMessage: 'Event monitor is unavailable' })
  }
})
