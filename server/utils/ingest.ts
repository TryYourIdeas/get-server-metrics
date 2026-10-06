import { decodePayload, parseCheckReply, parseEvent, parseReading, parseStatus, parseTopic } from 'computer-usage-agent/protocol'
import type { Bus } from './bus'
import { logDebug, logError } from './log'
import type { createRepository } from './repository'

type Repo = Pick<ReturnType<typeof createRepository>, 'saveSample' | 'saveEvent' | 'touchHost'>

const MAX_FUTURE_MS = 5 * 60_000
const preview = (p: Uint8Array | string) => (typeof p === 'string' ? p : new TextDecoder().decode(p)).slice(0, 200)

/**
 * Handles one MQTT message. Validation problems are logged and dropped (the promise resolves);
 * database errors reject so the caller can retry.
 */
export function createIngest({ repo, bus, now = () => new Date() }: { repo: Repo; bus: Bus; now?: () => Date }) {
  const reject = (reason: string, topic: string, payload: Uint8Array | string) => {
    logError('mqtt message rejected', { reason, topic, payload: preview(payload) })
  }
  const tooNew = (ts: string) => Date.parse(ts) > now().getTime() + MAX_FUTURE_MS

  return async function ingest(topic: string, payload: Uint8Array | string): Promise<void> {
    const t = parseTopic(topic)
    if (!t) return reject('unknown topic', topic, payload)
    const { host } = t
    const body = decodePayload(payload)

    switch (t.type) {
      case 'heartbeat': {
        const reading = parseReading(body)
        if (!reading) return reject('invalid reading', topic, payload)
        if (tooNew(reading.ts)) return reject('timestamp too far in the future', topic, payload)
        await repo.touchHost(host, { online: true }, now())
        const id = await repo.saveSample(host, reading)
        if (id !== null) bus.emit({ type: 'reading', host, reading, stored: true })
        return
      }
      case 'event': {
        const event = parseEvent(body)
        if (!event) return reject('invalid event', topic, payload)
        if (tooNew(event.ts)) return reject('timestamp too far in the future', topic, payload)
        await repo.touchHost(host, { online: true }, now())
        if (await repo.saveEvent(host, event)) bus.emit({ type: 'event', host, event })
        return
      }
      case 'reading': {
        const reply = parseCheckReply(body)
        if (!reply) return reject('invalid check reply', topic, payload)
        if (tooNew(reply.ts)) return reject('timestamp too far in the future', topic, payload)
        const { requestId, ...reading } = reply
        await repo.touchHost(host, { online: true }, now())
        bus.emit({ type: 'reading', host, reading, requestId, stored: false })
        return
      }
      case 'status': {
        const status = parseStatus(body)
        if (!status) return reject('invalid status', topic, payload)
        const online = status.state === 'online'
        await repo.touchHost(host, { online }, now())
        bus.emit({ type: 'status', host, online })
        return
      }
      default:
        logDebug('mqtt message ignored', { topic })
    }
  }
}
