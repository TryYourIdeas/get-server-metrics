import { describe, expect, it } from 'vitest'
import { readMqttConfig } from '../server/utils/mqtt'

describe('readMqttConfig', () => {
  it('applies defaults', () => {
    expect(readMqttConfig({})).toEqual({ url: 'mqtt://localhost:1883', username: 'app', password: undefined, heartbeatIntervalMs: 300000 })
  })
  it('reads overrides and ignores an invalid heartbeat interval', () => {
    expect(readMqttConfig({ MQTT_URL: 'mqtt://b:1', MQTT_USERNAME: 'u', MQTT_PASSWORD: 'p', HEARTBEAT_INTERVAL_MS: '1000' }))
      .toEqual({ url: 'mqtt://b:1', username: 'u', password: 'p', heartbeatIntervalMs: 1000 })
    expect(readMqttConfig({ HEARTBEAT_INTERVAL_MS: 'x' }).heartbeatIntervalMs).toBe(300000)
  })
})
