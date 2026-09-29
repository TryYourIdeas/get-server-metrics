import { getDb } from '../../db'
import { logDebug, logError } from '../../utils/log'
import { parseRange } from '../../utils/range'
import { createRepository } from '../../utils/repository'

export default defineEventHandler(async (event) => {
  const range = parseRange(getQuery(event).range)
  if (!range) throw createError({ statusCode: 400, statusMessage: 'range must be one of 1h, 24h, 7d' })
  try {
    const rows = await createRepository(getDb()).getHistory(range)
    logDebug('history served', { range, rows: rows.length })
    return rows
  } catch (err) {
    logError('history query failed', { range, error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read history' })
  }
})
