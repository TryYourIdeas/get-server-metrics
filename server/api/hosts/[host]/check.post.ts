import { isValidHostId } from 'computer-usage-agent/protocol'
import { createCheckRequester } from '../../../utils/check'
import { logDebug, logError } from '../../../utils/log'
import { isBrokerConnected, publishCheck } from '../../../utils/mqtt'

const requestCheck = createCheckRequester({ publish: publishCheck })

export default defineEventHandler(async (event) => {
  const host = getRouterParam(event, 'host')
  if (!isValidHostId(host)) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
  if (!isBrokerConnected()) throw createError({ statusCode: 503, statusMessage: 'MQTT broker is not connected' })
  try {
    const result = await requestCheck(host)
    if (!result.ok) throw createError({ statusCode: 429, statusMessage: 'Check requested too recently' })
    logDebug('check requested', { host, requestId: result.requestId })
    return { requestId: result.requestId }
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
    logError('check request failed', { host, error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not send the check request' })
  }
})
