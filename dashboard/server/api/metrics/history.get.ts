import { getDb } from '../../../../shared/server/db'
import { resolveHost } from '../../../../shared/server/utils/host'
import { logDebug, logError } from '../../../../shared/server/utils/log'
import { parseRange } from '../../../../shared/server/utils/range'
import { createRepository } from '../../../../shared/server/utils/repository'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const range = parseRange(q.range)
  if (!range) throw createError({ statusCode: 400, statusMessage: 'range must be one of 1h, 24h, 7d' })
  const repo = createRepository(getDb())
  try {
    const resolved = resolveHost(q.host, (await repo.listHosts()).map(h => h.hostId))
    if (!resolved.ok) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })
    if (!resolved.host) return []
    const rows = await repo.getHistory(resolved.host, range)
    logDebug('history served', { host: resolved.host, range, rows: rows.length })
    return rows
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
    logError('history query failed', { range, error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read history' })
  }
})
