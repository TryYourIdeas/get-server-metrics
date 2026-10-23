import { getDb } from '../db'
import { resolveHost } from '../utils/host'
import { logError } from '../utils/log'
import { createRepository } from '../utils/repository'

export default defineEventHandler(async (event) => {
  const repo = createRepository(getDb())
  const q = getQuery(event)
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20))
  try {
    const resolved = resolveHost(q.host, (await repo.listHosts()).map(h => h.hostId))
    if (!resolved.ok) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
    return resolved.host ? await repo.getRecentEvents(resolved.host, limit) : []
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
    logError('events query failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read events' })
  }
})
