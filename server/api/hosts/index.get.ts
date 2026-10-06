import { getDb } from '../../db'
import { logError } from '../../utils/log'
import { isBrokerConnected, readMqttConfig } from '../../utils/mqtt'
import { createRepository } from '../../utils/repository'

export default defineEventHandler(async () => {
  try {
    const hosts = await createRepository(getDb()).listHosts()
    return { hosts, brokerConnected: isBrokerConnected(), staleAfterMs: readMqttConfig(process.env).heartbeatIntervalMs * 2 }
  } catch (err) {
    logError('hosts query failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read hosts' })
  }
})
