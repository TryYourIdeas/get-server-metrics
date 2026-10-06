import type { MqttClient } from 'mqtt'
import { topic } from 'computer-usage-agent/protocol'

export interface MqttConfig { url: string; username?: string; password?: string; heartbeatIntervalMs: number }

export function readMqttConfig(env: Record<string, string | undefined>): MqttConfig {
  const hb = Number(env.HEARTBEAT_INTERVAL_MS)
  return {
    url: env.MQTT_URL || 'mqtt://localhost:1883',
    username: env.MQTT_USERNAME || 'app',
    password: env.MQTT_PASSWORD || undefined,
    heartbeatIntervalMs: Number.isFinite(hb) && hb > 0 ? hb : 300_000
  }
}

// One client per process, kept across dev HMR reloads.
const g = globalThis as { __computerUsageMqtt?: { client: MqttClient; connected: boolean } }

export function registerMqttClient(client: MqttClient): void {
  g.__computerUsageMqtt?.client.end(true)
  g.__computerUsageMqtt = { client, connected: false }
}
export function setBrokerConnected(connected: boolean): void {
  if (g.__computerUsageMqtt) g.__computerUsageMqtt.connected = connected
}
export const isBrokerConnected = (): boolean => g.__computerUsageMqtt?.connected ?? false

export async function publishCheck(host: string, requestId: string): Promise<void> {
  const state = g.__computerUsageMqtt
  if (!state?.connected) throw new Error('MQTT broker is not connected')
  await state.client.publishAsync(topic(host, 'check'), JSON.stringify({ requestId }), { qos: 1 })
}
