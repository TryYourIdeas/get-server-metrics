import { getDb } from '../../../../shared/server/db'
import { resolveHost } from '../../../../shared/server/utils/host'
import { logError } from '../../../../shared/server/utils/log'
import { createRepository } from '../../../../shared/server/utils/repository'

/** Latest stored reading for the host, or null before the first heartbeat arrives. */
export default defineEventHandler(async (event) => {
  const repo = createRepository(getDb())
  try {
    const resolved = resolveHost(getQuery(event).host, (await repo.listHosts()).map(h => h.hostId))
    if (!resolved.ok) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
    return resolved.host ? await repo.getLatest(resolved.host) : null
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
    logError('current metrics failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read system metrics' })
  }
})
