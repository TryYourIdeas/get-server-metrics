import { eventMonitorHeaders, eventMonitorUrl } from '../utils/event-monitor'
import { logError } from '../../../shared/server/utils/log'

export default defineEventHandler(async (event) => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  event.node.res.once('close', abort)
  try {
    const upstream = await fetch(eventMonitorUrl('/stream'), {
      headers: { accept: 'text/event-stream', ...eventMonitorHeaders() },
      signal: controller.signal
    })
    if (!upstream.ok || !upstream.body) throw new Error(`event monitor returned HTTP ${upstream.status}`)
    return new Response(upstream.body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no'
      }
    })
  } catch (err) {
    if (controller.signal.aborted) return
    logError('event monitor stream proxy failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 503, statusMessage: 'Event monitor is unavailable' })
  }
})
