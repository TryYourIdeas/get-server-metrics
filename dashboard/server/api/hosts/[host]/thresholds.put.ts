import { isValidHostId } from 'agent/protocol'
import { forwardToMonitor } from '../../../utils/event-monitor'

/** Sets one host's threshold override (any subset of the four values). */
export default defineEventHandler(async (event) => {
  const host = getRouterParam(event, 'host')
  if (!isValidHostId(host)) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
  return forwardToMonitor(`/hosts/${encodeURIComponent(host)}/thresholds`, { method: 'PUT', body: await readBody(event) })
})
