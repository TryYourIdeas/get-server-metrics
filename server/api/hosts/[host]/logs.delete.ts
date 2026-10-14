import { isValidHostId } from 'computer-usage-agent/protocol'
import { getDb } from '../../../db'
import { logError, logInfo } from '../../../utils/log'
import { createRepository } from '../../../utils/repository'

export default defineEventHandler(async (event) => {
  const host = getRouterParam(event, 'host')
  if (!isValidHostId(host)) throw createError({ statusCode: 400, statusMessage: 'invalid host id' })

  try {
    const deleted = await createRepository(getDb()).deleteHostLogs(host)
    logInfo('host logs deleted', { host, ...deleted })
    return deleted
  } catch (err) {
    logError('host logs deletion failed', { host, error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not delete host logs' })
  }
})
