import { DEFAULT_THRESHOLDS } from 'agent/protocol'
import { getDb } from '../../../shared/server/db'
import { logError } from '../../../shared/server/utils/log'
import { createRepository } from '../../../shared/server/utils/repository'

/** The default thresholds (stored, or the built-in values when none were saved) and every host's override. */
export default defineEventHandler(async () => {
  try {
    const settings = await createRepository(getDb()).getThresholdSettings()
    return { defaults: settings.defaults ?? DEFAULT_THRESHOLDS, overrides: settings.overrides, builtIn: DEFAULT_THRESHOLDS }
  } catch (err) {
    logError('threshold settings query failed', { error: err instanceof Error ? err.message : String(err) })
    throw createError({ statusCode: 500, statusMessage: 'Could not read the threshold settings' })
  }
})
