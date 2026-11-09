import { DEFAULT_THRESHOLDS, isValidHostId, resolveThresholds, type Thresholds } from 'agent/protocol'
import { logDebug, logError } from './log'
import { withRetry } from './retry'
import type { createRepository } from './repository'

type Repo = Pick<ReturnType<typeof createRepository>, 'getThresholdSettings' | 'listHosts'>

interface Deps {
  repo: Repo
  /** Sends a host its effective thresholds (the event monitor publishes them as a retained MQTT message). */
  publish: (host: string, thresholds: Thresholds) => Promise<void>
  /** How a failing publish is retried (default 5 attempts, 2 s apart) so a brief broker outage cannot strand a stale retained config. */
  retry?: { attempts: number; delayMs: number }
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Pushes each host's effective thresholds (its override over the defaults, or the built-in values when nothing
 * is saved) to the agents. Hosts with nothing to override are only told when something has ever been saved.
 */
export function createThresholdPublisher({ repo, publish, retry = { attempts: 5, delayMs: 2000 } }: Deps) {
  async function effective(hostId: string) {
    const settings = await repo.getThresholdSettings()
    return {
      thresholds: resolveThresholds(settings.defaults ?? DEFAULT_THRESHOLDS, settings.overrides[hostId]),
      anythingSaved: settings.defaults !== null || Object.keys(settings.overrides).length > 0
    }
  }

  async function publishHost(hostId: string): Promise<void> {
    // Host ids end up in an MQTT topic, so a wildcard or extra level must never get this far.
    if (!isValidHostId(hostId)) throw new Error(`invalid host id: ${String(hostId).slice(0, 80)}`)
    const { thresholds } = await effective(hostId)
    await withRetry(() => publish(hostId, thresholds), {
      ...retry,
      onRetry: (err, attempt) => logError('publishing thresholds failed, retrying', { hostId, attempt, error: errorMessage(err) })
    })
    logDebug('thresholds published', { hostId, ...thresholds })
  }

  return {
    publishHost,

    /** Every known host; one failing publish is logged and does not stop the others. */
    async publishAll(): Promise<void> {
      for (const { hostId } of await repo.listHosts()) {
        try { await publishHost(hostId) } catch (err) { logError('publishing thresholds failed', { hostId, error: errorMessage(err) }) }
      }
    },

    /** A host came online: give it the current values, but only if anything was ever saved in the dashboard. */
    async onHostOnline(hostId: string): Promise<void> {
      const { anythingSaved } = await effective(hostId)
      if (!anythingSaved) return
      await publishHost(hostId)
    }
  }
}
