import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THRESHOLDS, decodePayload, isValidHostId, isValidThreshold, parseCheckReply, parseCheckRequest, parseEvent,
  parseReading, parseStatus, parseThresholdOverride, parseThresholds, parseTopic, resolveThresholds, THRESHOLD_KEYS, topic
} from '../src/protocol'

const reading = { ts: '2026-01-01T00:00:00Z', cpuPercent: 12.5, memUsed: 5, memTotal: 10, disks: [{ mount: '/', used: 1, total: 2 }] }

describe('host ids and topics', () => {
  it('accepts ordinary host ids', () => {
    for (const h of ['local', 'web-01', 'db_2.prod', 'A'.repeat(64)]) expect(isValidHostId(h)).toBe(true)
  })
  it('rejects ids that could become wildcards or extra topic levels', () => {
    for (const h of ['', 'a/b', '+', '#', 'a b', 'A'.repeat(65), '.', '..', 'x#', undefined, 5]) expect(isValidHostId(h)).toBe(false)
  })
  it('builds and parses topics', () => {
    expect(topic('web-01', 'heartbeat')).toBe('computer-usage/web-01/heartbeat')
    expect(parseTopic('computer-usage/web-01/event')).toEqual({ host: 'web-01', type: 'event' })
  })
  it('rejects unknown roots, types, depth and bad hosts', () => {
    for (const t of ['other/h/event', 'computer-usage/h/nope', 'computer-usage/h', 'computer-usage/h/event/x', 'computer-usage/+/event', 'computer-usage//event']) {
      expect(parseTopic(t)).toBeNull()
    }
  })
})

describe('decodePayload', () => {
  it('decodes JSON from strings and bytes, and returns undefined for garbage', () => {
    expect(decodePayload('{"a":1}')).toEqual({ a: 1 })
    expect(decodePayload(new TextEncoder().encode('[1]'))).toEqual([1])
    expect(decodePayload('not json')).toBeUndefined()
  })
})

describe('parseReading', () => {
  it('accepts a valid reading', () => {
    expect(parseReading(reading)).toEqual(reading)
  })
  it('rejects bad shapes and out-of-range values', () => {
    const bad = [
      null, 'x', [], { ...reading, ts: 'nope' }, { ...reading, ts: undefined },
      { ...reading, cpuPercent: 250 }, { ...reading, cpuPercent: -1 }, { ...reading, cpuPercent: NaN },
      { ...reading, memUsed: -5 }, { ...reading, memTotal: 'x' }, { ...reading, disks: 'x' },
      { ...reading, disks: [{ mount: '', used: 1, total: 2 }] },
      { ...reading, disks: [{ mount: '/', used: -1, total: 2 }] },
      { ...reading, disks: Array.from({ length: 65 }, (_, i) => ({ mount: `/m${i}`, used: 1, total: 2 })) }
    ]
    for (const b of bad) expect(parseReading(b)).toBeNull()
  })
  it('strips unknown fields', () => {
    expect(parseReading({ ...reading, extra: 1 })).toEqual(reading)
  })
})

describe('parseEvent', () => {
  const ev = { kind: 'memory', state: 'alert', value: 93.1, threshold: 90, ts: '2026-01-01T00:00:00Z' }
  it('accepts cpu/memory events and disk events with a mount', () => {
    expect(parseEvent(ev)).toEqual(ev)
    expect(parseEvent({ ...ev, kind: 'disk', mount: '/data' })).toEqual({ ...ev, kind: 'disk', mount: '/data' })
  })
  it('rejects unknown kinds/states, a disk event without a mount, and bad numbers', () => {
    for (const b of [{ ...ev, kind: 'gpu' }, { ...ev, state: 'meh' }, { ...ev, kind: 'disk' }, { ...ev, value: 'x' }, { ...ev, ts: 'x' }, null]) {
      expect(parseEvent(b)).toBeNull()
    }
  })
})

describe('check and status messages', () => {
  it('parses a check request and rejects missing/oversized ids', () => {
    expect(parseCheckRequest({ requestId: 'r1' })).toEqual({ requestId: 'r1' })
    expect(parseCheckRequest({})).toBeNull()
    expect(parseCheckRequest({ requestId: 'x'.repeat(65) })).toBeNull()
  })
  it('parses a check reply (reading plus request id)', () => {
    expect(parseCheckReply({ ...reading, requestId: 'r1' })).toEqual({ ...reading, requestId: 'r1' })
    expect(parseCheckReply(reading)).toBeNull()
  })
  it('parses status', () => {
    expect(parseStatus({ state: 'online' })).toEqual({ state: 'online' })
    expect(parseStatus({ state: 'maybe' })).toBeNull()
  })
})

describe('config topic', () => {
  it('parseTopic accepts the config topic', () => {
    expect(parseTopic('computer-usage/h1/config')).toEqual({ host: 'h1', type: 'config' })
  })
})

describe('thresholds', () => {
  const valid = { cpuPercent: 90, cpuConsecutive: 3, memoryPercent: 90, diskPercent: 90 }

  it('has the built-in defaults and the four keys', () => {
    expect(DEFAULT_THRESHOLDS).toEqual(valid)
    expect([...THRESHOLD_KEYS]).toEqual(['cpuPercent', 'cpuConsecutive', 'memoryPercent', 'diskPercent'])
  })

  it('parseThresholds accepts a full valid set and ignores extra keys', () => {
    expect(parseThresholds(valid)).toEqual(valid)
    const edge = { cpuPercent: 1, cpuConsecutive: 1, memoryPercent: 100, diskPercent: 50.5 }
    expect(parseThresholds(edge)).toEqual(edge)
    expect(parseThresholds({ ...valid, note: 'x' })).toEqual(valid)
  })

  it('parseThresholds rejects missing keys, out-of-range values, wrong types and non-objects', () => {
    const { diskPercent: _omit, ...missing } = valid
    for (const bad of [
      missing, { ...valid, cpuPercent: 0 }, { ...valid, cpuPercent: 101 }, { ...valid, memoryPercent: '70' },
      { ...valid, diskPercent: NaN }, { ...valid, diskPercent: null }, { ...valid, cpuConsecutive: 0 },
      { ...valid, cpuConsecutive: 1.5 }, 'text', 5, null, undefined, [valid]
    ]) expect(parseThresholds(bad)).toBeNull()
  })

  it('parseThresholdOverride accepts any non-empty subset of known keys', () => {
    expect(parseThresholdOverride({ diskPercent: 80 })).toEqual({ diskPercent: 80 })
    expect(parseThresholdOverride({ cpuPercent: 70, cpuConsecutive: 5 })).toEqual({ cpuPercent: 70, cpuConsecutive: 5 })
  })

  it('parseThresholdOverride rejects empty, unknown-key, invalid-value and non-object input', () => {
    for (const bad of [{}, { diskPercent: 80, foo: 1 }, { diskPercent: 0 }, { cpuConsecutive: 2.5 }, { memoryPercent: '5' }, [], null, 'x'])
      expect(parseThresholdOverride(bad)).toBeNull()
  })

  it('isValidThreshold applies the per-key limits', () => {
    expect(isValidThreshold('cpuPercent', 100)).toBe(true)
    expect(isValidThreshold('cpuPercent', 100.1)).toBe(false)
    expect(isValidThreshold('cpuConsecutive', 2)).toBe(true)
    expect(isValidThreshold('cpuConsecutive', 2.5)).toBe(false)
  })

  it('resolveThresholds fills gaps from the defaults without mutating its inputs', () => {
    const defaults = { ...valid }
    const override = { diskPercent: 80 }
    expect(resolveThresholds(defaults, override)).toEqual({ ...valid, diskPercent: 80 })
    expect(resolveThresholds(defaults, null)).toEqual(valid)
    expect(resolveThresholds(defaults)).toEqual(valid)
    expect(defaults).toEqual(valid)
    expect(override).toEqual({ diskPercent: 80 })
  })
})
