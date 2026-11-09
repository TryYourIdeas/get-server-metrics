import mqtt, { type MqttClient } from 'mqtt'
import { afterEach, describe, expect, it } from 'vitest'
import { startAgent, type Agent, type AgentConfig } from '../src/agent'
import type { Reading } from '../src/protocol'
import { DEFAULT_THRESHOLDS } from '../src/thresholds'
import { freePort, startBroker } from './helpers/broker'

const reading = (o: Partial<Reading> = {}): Reading => ({
  ts: new Date().toISOString(), cpuPercent: 10, memUsed: 50, memTotal: 100, disks: [{ mount: '/', used: 10, total: 100 }], ...o
})
const config = (url: string, o: Partial<AgentConfig> = {}): AgentConfig => ({
  hostId: 'h1', mqttUrl: url, heartbeatIntervalMs: 60_000, checkIntervalMs: 60_000,
  thresholds: DEFAULT_THRESHOLDS, queueLimit: 100, reconnectPeriodMs: 100, ...o
})

type Msg = { topic: string; payload: any }
async function observe(url: string): Promise<{ client: MqttClient; msgs: Msg[] }> {
  const client = mqtt.connect(url)
  const msgs: Msg[] = []
  client.on('message', (topic, p) => {
    // The observer also sees deliberately malformed messages, so parsing must not throw.
    try { msgs.push({ topic, payload: JSON.parse(p.toString()) }) } catch { msgs.push({ topic, payload: p.toString() }) }
  })
  await new Promise<void>(r => client.on('connect', () => r()))
  await client.subscribeAsync('computer-usage/h1/#', { qos: 1 })
  return { client, msgs }
}
async function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = fn(); if (v !== undefined) return v; await new Promise(r => setTimeout(r, 25)) }
  throw new Error('timed out waiting for condition')
}

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c() })

describe('agent', () => {
  it('publishes online status and a heartbeat reading right after connecting', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const agent: Agent = startAgent(config(broker.url), async () => reading()); cleanup.push(() => agent.stop())
    await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/status' && m.payload.state === 'online'))
    const hb = await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/heartbeat'))
    expect(hb.payload).toMatchObject({ cpuPercent: 10, memTotal: 100 })
  })

  it('publishes an alert event when a threshold is crossed', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const agent = startAgent(config(broker.url), async () => reading({ memUsed: 95 })); cleanup.push(() => agent.stop())
    const e = await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/event'))
    expect(e.payload).toMatchObject({ kind: 'memory', state: 'alert', threshold: 90 })
  })

  it('answers a check request with a reading carrying the same request id', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const agent = startAgent(config(broker.url), async () => reading()); cleanup.push(() => agent.stop())
    await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/status'))
    await new Promise(r => setTimeout(r, 200)) // let the agent's check-topic subscription settle
    await client.publishAsync('computer-usage/h1/check', JSON.stringify({ requestId: 'r-42' }), { qos: 1 })
    const reply = await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/reading'))
    expect(reply.payload.requestId).toBe('r-42')
  })

  it('ignores a malformed check request and keeps running', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const agent = startAgent(config(broker.url), async () => reading()); cleanup.push(() => agent.stop())
    await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/status'))
    await new Promise(r => setTimeout(r, 200))
    await client.publishAsync('computer-usage/h1/check', 'not json', { qos: 1 })
    await client.publishAsync('computer-usage/h1/check', JSON.stringify({ requestId: 'ok-1' }), { qos: 1 })
    const reply = await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/reading'))
    expect(reply.payload.requestId).toBe('ok-1')
  })

  it('queues heartbeats while the broker is unreachable and delivers them after it comes up', async () => {
    const port = await freePort()
    const agent = startAgent(config(`mqtt://127.0.0.1:${port}`), async () => reading({ cpuPercent: 33 }))
    await new Promise(r => setTimeout(r, 400)) // first heartbeat is collected while offline
    const broker = await startBroker(port); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    cleanup.push(() => agent.stop()) // cleanup runs in reverse: the agent must stop before the broker it is connected to
    const hb = await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/heartbeat' && m.payload.cpuPercent === 33))
    expect(hb).toBeDefined()
  })
})

describe('agent threshold config', () => {
  const cfg = (o: Record<string, unknown> = {}) => JSON.stringify({ cpuPercent: 90, cpuConsecutive: 3, memoryPercent: 70, diskPercent: 90, ...o })
  const configTopic = 'computer-usage/h1/config'
  const memoryAlert = (msgs: Msg[]) => msgs.find(m => m.topic === 'computer-usage/h1/event' && m.payload.kind === 'memory' && m.payload.state === 'alert')

  it('applies a retained config that was published before it started', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    await client.publishAsync(configTopic, cfg(), { qos: 1, retain: true })
    const agent = startAgent(config(broker.url, { checkIntervalMs: 100 }), async () => reading({ memUsed: 80 })); cleanup.push(() => agent.stop())
    const alert = await waitFor(() => memoryAlert(msgs))
    expect(alert.payload.threshold).toBe(70)
  })

  it('applies a config received while running', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const agent = startAgent(config(broker.url, { checkIntervalMs: 100 }), async () => reading({ memUsed: 80 })); cleanup.push(() => agent.stop())
    await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/status' && m.payload.state === 'online'))
    await new Promise(r => setTimeout(r, 500))
    expect(memoryAlert(msgs)).toBeUndefined()
    await client.publishAsync(configTopic, cfg(), { qos: 1 })
    const alert = await waitFor(() => memoryAlert(msgs))
    expect(alert.payload.threshold).toBe(70)
  })

  it('ignores invalid configs and keeps its thresholds', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const agent = startAgent(config(broker.url, { checkIntervalMs: 100 }), async () => reading({ memUsed: 95 })); cleanup.push(() => agent.stop())
    await waitFor(() => msgs.find(m => m.topic === 'computer-usage/h1/status' && m.payload.state === 'online'))
    await client.publishAsync(configTopic, cfg({ cpuPercent: 150 }), { qos: 1 })
    await client.publishAsync(configTopic, cfg({ memoryPercent: '70' }), { qos: 1 })
    await client.publishAsync(configTopic, 'not json', { qos: 1 })
    const alert = await waitFor(() => memoryAlert(msgs))
    expect(alert.payload.threshold).toBe(90)
    await new Promise(r => setTimeout(r, 300))
    expect(msgs.filter(m => m.payload?.kind === 'memory')).toHaveLength(1)
  })

  it('uses its environment thresholds when no config was received', async () => {
    const broker = await startBroker(); cleanup.push(() => broker.stop())
    const { client, msgs } = await observe(broker.url); cleanup.push(() => client.endAsync())
    const thresholds = { ...DEFAULT_THRESHOLDS, memoryPercent: 95 }
    const agent = startAgent(config(broker.url, { thresholds }), async () => reading({ memUsed: 96 })); cleanup.push(() => agent.stop())
    const alert = await waitFor(() => memoryAlert(msgs))
    expect(alert.payload.threshold).toBe(95)
  })
})
