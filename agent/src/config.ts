import type { AgentConfig } from './agent'
import { isValidHostId } from './protocol'
import { DEFAULT_THRESHOLDS } from './thresholds'

type Env = Record<string, string | undefined>

function num(env: Env, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}, got "${raw}"`)
  return n
}

export function readAgentConfig(env: Env): AgentConfig {
  const hostId = env.HOST_ID
  if (!isValidHostId(hostId)) throw new Error('HOST_ID is required: 1-64 characters of letters, digits, "_", "." or "-"')
  return {
    hostId,
    mqttUrl: env.MQTT_URL || 'mqtt://localhost:1883',
    username: env.MQTT_USERNAME || hostId,
    password: env.MQTT_PASSWORD || undefined,
    heartbeatIntervalMs: num(env, 'HEARTBEAT_INTERVAL_MS', 300_000, 1),
    checkIntervalMs: num(env, 'CHECK_INTERVAL_MS', 20_000, 1),
    queueLimit: num(env, 'QUEUE_LIMIT', 1000, 1),
    thresholds: {
      cpuPercent: num(env, 'CPU_THRESHOLD_PERCENT', DEFAULT_THRESHOLDS.cpuPercent, 1, 100),
      cpuConsecutive: num(env, 'CPU_CONSECUTIVE_CHECKS', DEFAULT_THRESHOLDS.cpuConsecutive, 1),
      memoryPercent: num(env, 'MEMORY_THRESHOLD_PERCENT', DEFAULT_THRESHOLDS.memoryPercent, 1, 100),
      diskPercent: num(env, 'DISK_THRESHOLD_PERCENT', DEFAULT_THRESHOLDS.diskPercent, 1, 100)
    }
  }
}

/** Problems that do not stop the agent but would make the broker silently drop what it publishes. */
export function configWarnings(cfg: AgentConfig): string[] {
  if (cfg.username && cfg.username !== cfg.hostId) {
    return [`MQTT_USERNAME "${cfg.username}" differs from HOST_ID "${cfg.hostId}": the broker only lets a user publish under its own host topic, so this agent's messages will be dropped`]
  }
  return []
}
