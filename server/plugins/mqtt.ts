import mqtt from 'mqtt'
import { TOPIC_ROOT } from 'computer-usage-agent/protocol'
import { getDb } from '../db'
import { bus } from '../utils/bus'
import { createIngest } from '../utils/ingest'
import { logDebug, logError, logInfo } from '../utils/log'
import { readMqttConfig, registerMqttClient, setBrokerConnected } from '../utils/mqtt'
import { ensureDbReady } from '../utils/ready'
import { createRepository } from '../utils/repository'
import { withRetry } from '../utils/retry'

const SUBSCRIPTIONS = ['heartbeat', 'event', 'reading', 'status'].map(t => `${TOPIC_ROOT}/+/${t}`)
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

export default defineNitroPlugin((nitroApp) => {
  const cfg = readMqttConfig(process.env)
  const ingest = createIngest({ repo: createRepository(getDb()), bus })

  // Persistent session + QoS 1: the broker queues messages meant for us while the app is down.
  const client = mqtt.connect(cfg.url, {
    clientId: 'computer-usage-app',
    clean: false,
    reconnectPeriod: 2000,
    username: cfg.username,
    password: cfg.password
  })
  registerMqttClient(client)

  client.on('connect', () => {
    setBrokerConnected(true)
    bus.emit({ type: 'broker', connected: true })
    logInfo('connected to MQTT broker', { url: cfg.url })
    client.subscribe(SUBSCRIPTIONS, { qos: 1 }, (err) => { if (err) logError('mqtt subscribe failed', { topics: SUBSCRIPTIONS, error: errMsg(err) }) })
  })
  client.on('close', () => {
    setBrokerConnected(false)
    bus.emit({ type: 'broker', connected: false })
    logDebug('mqtt connection closed')
  })
  client.on('error', err => logError('mqtt error', { url: cfg.url, error: errMsg(err) }))

  // Messages are handled one at a time, in arrival order. A database outage is retried for ~10 s before a message is dropped.
  let chain: Promise<void> = Promise.resolve()
  client.on('message', (topic, payload) => {
    chain = chain
      .then(() => withRetry(async () => { await ensureDbReady(); await ingest(topic, payload) }, {
        attempts: 5,
        delayMs: 2000,
        onRetry: (err, attempt) => logError('ingest failed, retrying', { topic, attempt, error: errMsg(err) })
      }))
      .catch(err => logError('ingest failed, message dropped', { topic, error: errMsg(err) }))
  })

  nitroApp.hooks.hook('close', () => { client.end(true) })
})
