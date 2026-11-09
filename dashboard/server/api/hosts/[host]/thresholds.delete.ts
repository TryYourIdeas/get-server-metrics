import { isValidHostId } from 'agent/protocol'
import { forwardToMonitor } from '../../../utils/event-monitor'

/** Removes one host's override so it uses the default thresholds again. */
export default defineEventHandler(async (event) => {
  const host = getRouterParam(event, 'host')
  if (!isValidHostId(host)) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
  return forwardToMonitor(`/hosts/${encodeURIComponent(host)}/thresholds`, { method: 'DELETE' })
})
