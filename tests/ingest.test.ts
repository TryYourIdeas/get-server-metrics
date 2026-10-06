import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBus, type BusEvent } from '../server/utils/bus'
import { createIngest } from '../server/utils/ingest'

const now = () => new Date('2026-01-01T12:00:00Z')
const reading = { ts: '2026-01-01T11:59:00Z', cpuPercent: 10, memUsed: 5, memTotal: 10, disks: [{ mount: '/', used: 1, total: 2 }] }
const event = { kind: 'memory', state: 'alert', value: 93, threshold: 90, ts: '2026-01-01T11:59:00Z' }

let repo: { saveSample: any; saveEvent: any; touchHost: any }
let seen: BusEvent[]
let ingest: (t: string, p: string) => Promise<void>

beforeEach(() => {
  repo = { saveSample: vi.fn().mockResolvedValue(1), saveEvent: vi.fn().mockResolvedValue(true), touchHost: vi.fn().mockResolvedValue(undefined) }
  const bus = createBus()
  seen = []
  bus.subscribe(e => seen.push(e))
  ingest = createIngest({ repo, bus, now })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('heartbeat', () => {
  it('stores the reading, marks the host online and emits it', async () => {
    await ingest('computer-usage/web-01/heartbeat', JSON.stringify(reading))
    expect(repo.touchHost).toHaveBeenCalledWith('web-01', { online: true }, now())
    expect(repo.saveSample).toHaveBeenCalledWith('web-01', reading)
    expect(seen).toEqual([{ type: 'reading', host: 'web-01', reading, stored: true }])
  })
  it('does not emit again for a duplicate delivery', async () => {
    repo.saveSample.mockResolvedValue(null)
    await ingest('computer-usage/web-01/heartbeat', JSON.stringify(reading))
    expect(seen).toEqual([])
  })
  it('drops garbage without storing, throwing or emitting', async () => {
    for (const payload of ['not json', '{}', JSON.stringify({ ...reading, cpuPercent: 250 }), JSON.stringify({ ...reading, memUsed: -1 })]) {
      await expect(ingest('computer-usage/web-01/heartbeat', payload)).resolves.toBeUndefined()
    }
    expect(repo.saveSample).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })
  it('rejects a timestamp more than 5 minutes in the future', async () => {
    await ingest('computer-usage/web-01/heartbeat', JSON.stringify({ ...reading, ts: '2026-01-02T00:00:00Z' }))
    expect(repo.saveSample).not.toHaveBeenCalled()
  })
  it('lets database errors propagate so the caller can retry', async () => {
    repo.saveSample.mockRejectedValue(new Error('db down'))
    await expect(ingest('computer-usage/web-01/heartbeat', JSON.stringify(reading))).rejects.toThrow('db down')
  })
})

describe('event', () => {
  it('stores and emits an event, once', async () => {
    await ingest('computer-usage/web-01/event', JSON.stringify(event))
    expect(repo.saveEvent).toHaveBeenCalledWith('web-01', event)
    expect(seen).toEqual([{ type: 'event', host: 'web-01', event }])
    repo.saveEvent.mockResolvedValue(false)
    seen.length = 0
    await ingest('computer-usage/web-01/event', JSON.stringify(event))
    expect(seen).toEqual([])
  })
  it('drops an event with an unknown kind', async () => {
    await ingest('computer-usage/web-01/event', JSON.stringify({ ...event, kind: 'gpu' }))
    expect(repo.saveEvent).not.toHaveBeenCalled()
  })
})

describe('check reply', () => {
  it('is forwarded with its request id but never stored', async () => {
    await ingest('computer-usage/web-01/reading', JSON.stringify({ ...reading, requestId: 'r1' }))
    expect(repo.saveSample).not.toHaveBeenCalled()
    expect(seen).toEqual([{ type: 'reading', host: 'web-01', reading, requestId: 'r1', stored: false }])
  })
})

describe('status', () => {
  it('records online/offline and emits it', async () => {
    await ingest('computer-usage/web-01/status', JSON.stringify({ state: 'offline' }))
    expect(repo.touchHost).toHaveBeenCalledWith('web-01', { online: false }, now())
    expect(seen).toEqual([{ type: 'status', host: 'web-01', online: false }])
  })
})

describe('topics', () => {
  it('ignores unknown or hostile topics and our own check topic', async () => {
    for (const t of ['other/web-01/heartbeat', 'computer-usage/+/heartbeat', 'computer-usage/a/b/heartbeat', 'computer-usage/web-01/check']) {
      await expect(ingest(t, JSON.stringify(reading))).resolves.toBeUndefined()
    }
    expect(repo.saveSample).not.toHaveBeenCalled()
    expect(repo.touchHost).not.toHaveBeenCalled()
  })
})
