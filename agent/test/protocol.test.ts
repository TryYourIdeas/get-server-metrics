import { describe, expect, it } from 'vitest'
import {
  decodePayload, isValidHostId, parseCheckReply, parseCheckRequest, parseEvent,
  parseReading, parseStatus, parseTopic, topic
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
