/** Wire protocol shared by the agent and the app. Must stay dependency-free: the Nuxt app imports it directly. */

export const TOPIC_ROOT = 'computer-usage'
export const MESSAGE_TYPES = ['heartbeat', 'event', 'check', 'reading', 'status'] as const
export type MessageType = typeof MESSAGE_TYPES[number]

export interface DiskReading { mount: string; used: number; total: number }
export interface Reading { ts: string; cpuPercent: number; memUsed: number; memTotal: number; disks: DiskReading[] }
export type EventKind = 'cpu' | 'memory' | 'disk'
export interface UsageEvent { kind: EventKind; state: 'alert' | 'ok'; value: number; threshold: number; mount?: string; ts: string }
export interface CheckRequest { requestId: string }
export interface CheckReply extends Reading { requestId: string }
export interface StatusMessage { state: 'online' | 'offline' }

const HOST_ID = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_DISKS = 64
const MAX_MOUNT_LENGTH = 512
const MAX_REQUEST_ID_LENGTH = 64

/** Host ids end up inside MQTT topics, so anything that could be a wildcard or extra level is invalid. */
export const isValidHostId = (v: unknown): v is string => typeof v === 'string' && HOST_ID.test(v) && !/^\.+$/.test(v)

export const topic = (host: string, type: MessageType): string => `${TOPIC_ROOT}/${host}/${type}`

export function parseTopic(t: string): { host: string; type: MessageType } | null {
  const parts = t.split('/')
  if (parts.length !== 3 || parts[0] !== TOPIC_ROOT) return null
  const host = parts[1]!
  const type = parts[2]!
  if (!isValidHostId(host) || !(MESSAGE_TYPES as readonly string[]).includes(type)) return null
  return { host, type: type as MessageType }
}

export function decodePayload(payload: Uint8Array | string): unknown {
  try {
    return JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(payload))
  } catch {
    return undefined
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNonNeg = (v: unknown): v is number => isNum(v) && v >= 0
const isTs = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isMount = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= MAX_MOUNT_LENGTH

export function parseReading(v: unknown): Reading | null {
  if (!isObj(v)) return null
  const { ts, cpuPercent, memUsed, memTotal, disks } = v
  if (!isTs(ts) || !isNum(cpuPercent) || cpuPercent < 0 || cpuPercent > 100) return null
  if (!isNonNeg(memUsed) || !isNonNeg(memTotal) || !Array.isArray(disks) || disks.length > MAX_DISKS) return null
  const out: DiskReading[] = []
  for (const d of disks) {
    if (!isObj(d) || !isMount(d.mount) || !isNonNeg(d.used) || !isNonNeg(d.total)) return null
    out.push({ mount: d.mount, used: d.used, total: d.total })
  }
  return { ts, cpuPercent, memUsed, memTotal, disks: out }
}

export function parseEvent(v: unknown): UsageEvent | null {
  if (!isObj(v)) return null
  const { kind, state, value, threshold, ts, mount } = v
  if (kind !== 'cpu' && kind !== 'memory' && kind !== 'disk') return null
  if (state !== 'alert' && state !== 'ok') return null
  if (!isNum(value) || !isNum(threshold) || !isTs(ts)) return null
  if (kind === 'disk') {
    if (!isMount(mount)) return null
    return { kind, state, value, threshold, ts, mount }
  }
  return { kind, state, value, threshold, ts }
}

export function parseCheckRequest(v: unknown): CheckRequest | null {
  if (!isObj(v) || typeof v.requestId !== 'string' || v.requestId === '' || v.requestId.length > MAX_REQUEST_ID_LENGTH) return null
  return { requestId: v.requestId }
}

export function parseCheckReply(v: unknown): CheckReply | null {
  const req = parseCheckRequest(v)
  const reading = parseReading(v)
  return req && reading ? { ...reading, requestId: req.requestId } : null
}

export function parseStatus(v: unknown): StatusMessage | null {
  if (!isObj(v) || (v.state !== 'online' && v.state !== 'offline')) return null
  return { state: v.state }
}
