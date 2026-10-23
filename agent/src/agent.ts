import mqtt from 'mqtt'
import { collectReading } from './collector'
import { logDebug, logError, logInfo } from './log'
import { decodePayload, parseCheckRequest, topic, type MessageType, type Reading } from './protocol'
import { createBoundedQueue } from './queue'
import { createThresholdEvaluator, type Thresholds } from './thresholds'

export interface AgentConfig {
  hostId: string
  mqttUrl: string
  username?: string
  password?: string
  heartbeatIntervalMs: number
  checkIntervalMs: number
  thresholds: Thresholds
  queueLimit: number
  reconnectPeriodMs?: number
}
export interface Agent { stop(): Promise<void> }

interface Outgoing { topic: string; payload: string }
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function startAgent(cfg: AgentConfig, collect: () => Promise<Reading> = () => collectReading()): Agent {
  const evaluate = createThresholdEvaluator(cfg.thresholds)
  const queue = createBoundedQueue<Outgoing>(cfg.queueLimit)
  const statusTopic = topic(cfg.hostId, 'status')
  const checkTopic = topic(cfg.hostId, 'check')
  const offline = JSON.stringify({ state: 'offline' })

  const client = mqtt.connect(cfg.mqttUrl, {
    clientId: `computer-usage-agent-${cfg.hostId}`,
    clean: false, // persistent session: the broker keeps QoS 1 messages meant for us while we are away
    reconnectPeriod: cfg.reconnectPeriodMs ?? 2000,
    username: cfg.username,
    password: cfg.password,
    will: { topic: statusTopic, payload: Buffer.from(offline), qos: 1, retain: true }
  })

  const publish = (type: MessageType, payload: unknown, queueIfOffline: boolean) => {
    const msg = { topic: topic(cfg.hostId, type), payload: JSON.stringify(payload) }
    if (client.connected) {
      client.publish(msg.topic, msg.payload, { qos: 1 }, (err) => { if (err) logError('publish failed', { topic: msg.topic, error: errMsg(err) }) })
    } else if (queueIfOffline) {
      queue.push(msg)
      logDebug('queued while offline', { topic: msg.topic, queued: queue.size, dropped: queue.dropped })
    }
  }

  /** Runs `fn` unless the previous run is still going; failures are logged and swallowed so the timer keeps firing. */
  const guarded = (name: string, fn: () => Promise<void>) => {
    let running = false
    return async () => {
      if (running) { logDebug(`${name} skipped: previous still running`); return }
      running = true
      try { await fn() } catch (err) { logError(`${name} failed`, { hostId: cfg.hostId, error: errMsg(err) }) } finally { running = false }
    }
  }

  const heartbeat = guarded('heartbeat', async () => {
    publish('heartbeat', await collect(), true)
    logDebug('heartbeat collected', { hostId: cfg.hostId })
  })
  const thresholdCheck = guarded('threshold check', async () => {
    for (const e of evaluate(await collect())) {
      logInfo('threshold event', { hostId: cfg.hostId, ...e })
      publish('event', e, true)
    }
  })
  const answerCheck = async (requestId: string) => {
    try {
      publish('reading', { ...(await collect()), requestId }, false)
      logDebug('check answered', { requestId })
    } catch (err) {
      logError('check reply failed', { hostId: cfg.hostId, requestId, error: errMsg(err) })
    }
  }

  client.on('connect', () => {
    logInfo('connected to broker', { hostId: cfg.hostId, queued: queue.size })
    client.publish(statusTopic, JSON.stringify({ state: 'online' }), { qos: 1, retain: true })
    client.subscribe(checkTopic, { qos: 1 }, (err) => { if (err) logError('subscribe failed', { topic: checkTopic, error: errMsg(err) }) })
    for (const m of queue.drain()) client.publish(m.topic, m.payload, { qos: 1 })
  })
  client.on('error', err => logError('mqtt error', { hostId: cfg.hostId, error: errMsg(err) }))
  client.on('close', () => logDebug('mqtt connection closed', { hostId: cfg.hostId }))
  client.on('message', (t, payload) => {
    if (t !== checkTopic) return
    const req = parseCheckRequest(decodePayload(payload))
    if (!req) { logError('invalid check request', { hostId: cfg.hostId, payload: payload.toString().slice(0, 200) }); return }
    void answerCheck(req.requestId)
  })

  void heartbeat()
  void thresholdCheck()
  const heartbeatTimer = setInterval(() => void heartbeat(), cfg.heartbeatIntervalMs)
  const checkTimer = setInterval(() => void thresholdCheck(), cfg.checkIntervalMs)
  logInfo('agent started', { hostId: cfg.hostId, heartbeatIntervalMs: cfg.heartbeatIntervalMs, checkIntervalMs: cfg.checkIntervalMs })

  return {
    async stop() {
      clearInterval(heartbeatTimer)
      clearInterval(checkTimer)
      if (client.connected) await client.publishAsync(statusTopic, offline, { qos: 1, retain: true })
      await client.endAsync()
      logInfo('agent stopped', { hostId: cfg.hostId })
    }
  }
}
