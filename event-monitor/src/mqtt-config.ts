export interface MqttConfig {
  url: string
  username?: string
  password?: string
  heartbeatIntervalMs: number
}

export function readMqttConfig(env: Record<string, string | undefined>): MqttConfig {
  const heartbeatIntervalMs = Number(env.HEARTBEAT_INTERVAL_MS)
  return {
    url: env.MQTT_URL || 'mqtt://localhost:1883',
    username: env.MQTT_USERNAME || 'app',
    password: env.MQTT_PASSWORD || undefined,
    heartbeatIntervalMs: Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0 ? heartbeatIntervalMs : 300_000
  }
}
