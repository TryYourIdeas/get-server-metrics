import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMqttConfig } from '../event-monitor/src/mqtt-config'
import { eventMonitorHeaders, eventMonitorUrl } from '../dashboard/server/utils/event-monitor'

describe('readMqttConfig', () => {
  it('applies defaults', () => {
    expect(readMqttConfig({})).toEqual({ url: 'mqtt://localhost:1883', username: 'app', password: undefined, heartbeatIntervalMs: 300000 })
  })

  describe('event monitor URL and authentication', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('uses a local default URL and forwards configured tokens', () => {
      vi.stubEnv('EVENT_MONITOR_URL', '')
      vi.stubEnv('EVENT_MONITOR_TOKEN', '')
      expect(eventMonitorUrl('/health')).toBe('http://127.0.0.1:3100/health')
      expect(eventMonitorHeaders()).toEqual({})
      vi.stubEnv('EVENT_MONITOR_TOKEN', 'test-token')
      expect(eventMonitorHeaders()).toEqual({ authorization: 'Bearer test-token' })
    })
  })
  it('reads overrides and ignores an invalid heartbeat interval', () => {
    expect(readMqttConfig({ MQTT_URL: 'mqtt://b:1', MQTT_USERNAME: 'u', MQTT_PASSWORD: 'p', HEARTBEAT_INTERVAL_MS: '1000' }))
      .toEqual({ url: 'mqtt://b:1', username: 'u', password: 'p', heartbeatIntervalMs: 1000 })
    expect(readMqttConfig({ HEARTBEAT_INTERVAL_MS: 'x' }).heartbeatIntervalMs).toBe(300000)
  })
})
