import { describe, expect, it } from 'vitest'
import { configWarnings, readAgentConfig } from '../src/config'

describe('readAgentConfig', () => {
  it('applies defaults and uses the host id as the MQTT username', () => {
    const c = readAgentConfig({ HOST_ID: 'web-01' })
    expect(c).toMatchObject({
      hostId: 'web-01', mqttUrl: 'mqtt://localhost:1883', username: 'web-01',
      heartbeatIntervalMs: 300000, checkIntervalMs: 20000, queueLimit: 1000,
      thresholds: { cpuPercent: 90, cpuConsecutive: 3, memoryPercent: 90, diskPercent: 90 }
    })
  })
  it('reads overrides', () => {
    const c = readAgentConfig({
      HOST_ID: 'h', MQTT_URL: 'mqtt://broker:1883', MQTT_USERNAME: 'u', MQTT_PASSWORD: 'p', HEARTBEAT_INTERVAL_MS: '1000',
      CHECK_INTERVAL_MS: '500', CPU_THRESHOLD_PERCENT: '80', CPU_CONSECUTIVE_CHECKS: '2', MEMORY_THRESHOLD_PERCENT: '85', DISK_THRESHOLD_PERCENT: '95', QUEUE_LIMIT: '10'
    })
    expect(c).toMatchObject({ mqttUrl: 'mqtt://broker:1883', username: 'u', password: 'p', heartbeatIntervalMs: 1000, checkIntervalMs: 500, queueLimit: 10, thresholds: { cpuPercent: 80, cpuConsecutive: 2, memoryPercent: 85, diskPercent: 95 } })
  })
  it('requires a valid HOST_ID', () => {
    expect(() => readAgentConfig({})).toThrow(/HOST_ID/)
    expect(() => readAgentConfig({ HOST_ID: 'a/b' })).toThrow(/HOST_ID/)
  })
  it('names the variable when a number is invalid', () => {
    expect(() => readAgentConfig({ HOST_ID: 'h', HEARTBEAT_INTERVAL_MS: 'soon' })).toThrow(/HEARTBEAT_INTERVAL_MS/)
    expect(() => readAgentConfig({ HOST_ID: 'h', CPU_THRESHOLD_PERCENT: '150' })).toThrow(/CPU_THRESHOLD_PERCENT/)
    expect(() => readAgentConfig({ HOST_ID: 'h', CHECK_INTERVAL_MS: '0' })).toThrow(/CHECK_INTERVAL_MS/)
  })
})

describe('configWarnings', () => {
  it('warns when the MQTT username differs from the host id, because the broker ACL would drop its messages', () => {
    const w = configWarnings(readAgentConfig({ HOST_ID: 'web-01', MQTT_USERNAME: 'app' }))
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/MQTT_USERNAME.*HOST_ID/)
  })
  it('is quiet when they match or the username defaults', () => {
    expect(configWarnings(readAgentConfig({ HOST_ID: 'web-01' }))).toEqual([])
    expect(configWarnings(readAgentConfig({ HOST_ID: 'web-01', MQTT_USERNAME: 'web-01' }))).toEqual([])
  })
})
