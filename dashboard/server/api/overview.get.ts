import { getDb } from '../../../shared/server/db'
import { logError } from '../../../shared/server/utils/log'
import { createRepository } from '../../../shared/server/utils/repository'

/** Every machine with its latest reading and recent events, for the all-servers view. */
export default defineEventHandler(async () => {
  try {
    return { entries: await createRepository(getDb()).getOverview() }
  } catch (err) {
    logError('overview query failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read the overview' })
  }
})
