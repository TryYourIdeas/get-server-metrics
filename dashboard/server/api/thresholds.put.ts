import { forwardToMonitor } from '../utils/event-monitor'

/** Replaces the default thresholds; the event monitor validates, saves and pushes them to the agents. */
export default defineEventHandler(async (event) => {
  return forwardToMonitor('/thresholds', { method: 'PUT', body: await readBody(event) })
})
