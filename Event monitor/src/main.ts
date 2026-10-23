import mqtt from 'mqtt'
import { isValidHostId, TOPIC_ROOT, topic } from 'agent/protocol'
import { createServer, type ServerResponse } from 'node:http'
import { createDb } from '../../shared/server/db'
import { runMigrations } from '../../shared/server/db/migrate'
import { bus } from '../../shared/server/utils/bus'
import { createCheckRequester } from '../../shared/server/utils/check'
import { createIngest } from '../../shared/server/utils/ingest'
import { logDebug, logError, logInfo } from '../../shared/server/utils/log'
import { createRepository } from '../../shared/server/utils/repository'
import { createPruner, parseRetentionDays, PRUNE_INTERVAL_MS } from '../../shared/server/utils/retention'
import { withRetry } from '../../shared/server/utils/retry'
import { readMqttConfig } from './mqtt-config'

const SUBSCRIPTIONS = ['heartbeat', 'event', 'reading', 'status'].map(type => `${TOPIC_ROOT}/+/${type}`)
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function main() {
  const host = process.env.EVENT_MONITOR_HOST || '127.0.0.1'
  const port = Number(process.env.EVENT_MONITOR_PORT || 3100)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('EVENT_MONITOR_PORT must be between 1 and 65535')
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !process.env.EVENT_MONITOR_TOKEN) {
    throw new Error('Set EVENT_MONITOR_TOKEN before binding the event monitor to a non-loopback address')
  }

  const { db, pool } = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/computer-usage')
  try {
    await runMigrations(db)
  } catch (err) {
    await pool.end()
    throw err
  }

  const repo = createRepository(db)
  const cfg = readMqttConfig(process.env)
  const retentionDays = parseRetentionDays(process.env.RETENTION_DAYS)
  const prune = createPruner({
    retentionDays,
    prune: async cutoff => {
      const samples = await repo.pruneOlderThan(cutoff)
      await repo.pruneEventsOlderThan(cutoff)
      return samples
    }
  })
  void prune()
  const pruneTimer = setInterval(() => { void prune() }, PRUNE_INTERVAL_MS)
  const ingest = createIngest({ repo, bus })
  let brokerConnected = false

  const client = mqtt.connect(cfg.url, {
    clientId: 'computer-usage-app',
    clean: false,
    reconnectPeriod: 2000,
    username: cfg.username,
    password: cfg.password
  })
  const requestCheck = createCheckRequester({
    publish: async (host, requestId) => {
      await client.publishAsync(topic(host, 'check'), JSON.stringify({ requestId }), { qos: 1 })
    }
  })

  client.on('connect', () => {
    brokerConnected = true
    bus.emit({ type: 'broker', connected: true })
    logInfo('connected to MQTT broker', { url: cfg.url })
    client.subscribe(SUBSCRIPTIONS, { qos: 1 }, err => {
      if (err) logError('mqtt subscribe failed', { topics: SUBSCRIPTIONS, error: errorMessage(err) })
    })
  })
  client.on('close', () => {
    brokerConnected = false
    bus.emit({ type: 'broker', connected: false })
    logDebug('mqtt connection closed')
  })
  client.on('error', err => logError('mqtt error', { url: cfg.url, error: errorMessage(err) }))

  let chain: Promise<void> = Promise.resolve()
  client.on('message', (topicName, payload) => {
    chain = chain
      .then(() => withRetry(() => ingest(topicName, payload), {
        attempts: 5,
        delayMs: 2000,
        onRetry: (err, attempt) => logError('ingest failed, retrying', { topic: topicName, attempt, error: errorMessage(err) })
      }))
      .catch(err => logError('ingest failed, message dropped', { topic: topicName, error: errorMessage(err) }))
  })

  const httpServer = createServer((req, res) => {
    void (async () => {
      const token = process.env.EVENT_MONITOR_TOKEN
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        return json(res, 401, { error: 'unauthorized' })
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { brokerConnected, staleAfterMs: cfg.heartbeatIntervalMs * 2 })
      }
      if (req.method === 'GET' && url.pathname === '/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        })
        const unsubscribe = bus.subscribe(message => { res.write(`data: ${JSON.stringify(message)}\n\n`) })
        const ping = setInterval(() => { res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`) }, 25_000)
        const close = () => { clearInterval(ping); unsubscribe() }
        res.on('close', close)
        res.write(`data: ${JSON.stringify({ type: 'broker', connected: brokerConnected })}\n\n`)
        return
      }

      const checkMatch = url.pathname.match(/^\/hosts\/([^/]+)\/check$/)
      if (req.method === 'POST' && checkMatch) {
        let host: string
        try { host = decodeURIComponent(checkMatch[1]!) } catch { return json(res, 400, { error: 'invalid host id' }) }
        if (!isValidHostId(host)) return json(res, 400, { error: 'invalid host id' })
        if (!brokerConnected) return json(res, 503, { error: 'MQTT broker is not connected' })
        const result = await requestCheck(host)
        if (!result.ok) return json(res, 429, { error: 'Check requested too recently' })
        logDebug('check requested', { host, requestId: result.requestId })
        return json(res, 200, { requestId: result.requestId })
      }

      const logsMatch = url.pathname.match(/^\/hosts\/([^/]+)\/logs$/)
      if (req.method === 'DELETE' && logsMatch) {
        let host: string
        try { host = decodeURIComponent(logsMatch[1]!) } catch { return json(res, 400, { error: 'invalid host id' }) }
        if (!isValidHostId(host)) return json(res, 400, { error: 'invalid host id' })
        const deleted = await repo.deleteHostLogs(host)
        logInfo('host logs deleted', { host, ...deleted })
        return json(res, 200, deleted)
      }

      return json(res, 404, { error: 'not found' })
    })().catch(err => {
      logError('event monitor request failed', { error: errorMessage(err) })
      if (!res.headersSent) json(res, 500, { error: 'Internal server error' })
      else res.destroy()
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject)
        resolve()
      })
    })
  } catch (err) {
    clearInterval(pruneTimer)
    await client.endAsync(true)
    await chain
    await pool.end()
    throw err
  }
  logInfo('event monitor listening', { host, port, retentionDays, retentionEnabled: retentionDays > 0 })

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(pruneTimer)
    httpServer.close()
    httpServer.closeAllConnections()
    try {
      await client.endAsync(true)
      await chain
      await pool.end()
      logInfo('event monitor stopped')
    } catch (err) {
      logError('event monitor shutdown failed', { error: errorMessage(err) })
      process.exitCode = 1
    }
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  logInfo('event monitor started', { mqttUrl: cfg.url })
}

void main().catch(err => {
  logError('event monitor startup failed', { error: errorMessage(err) })
  process.exitCode = 1
})
