import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_THRESHOLDS, type Thresholds } from 'agent/protocol'
import { createThresholdPublisher } from '../shared/server/utils/threshold-publisher'

type Settings = { defaults: Thresholds | null; overrides: Record<string, Partial<Thresholds>> }
const host = (hostId: string) => ({ hostId, online: true, lastSeen: '2026-01-01T00:00:00Z' })
const custom: Thresholds = { cpuPercent: 80, cpuConsecutive: 2, memoryPercent: 70, diskPercent: 60 }

let settings: Settings
let hosts: string[]
let publish: ReturnType<typeof vi.fn>
let publisher: ReturnType<typeof createThresholdPublisher>

beforeEach(() => {
  settings = { defaults: null, overrides: {} }
  hosts = ['a', 'b']
  publish = vi.fn().mockResolvedValue(undefined)
  publisher = createThresholdPublisher({
    repo: { getThresholdSettings: async () => settings, listHosts: async () => hosts.map(host) },
    publish
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('publishHost', () => {
  it('uses the override over the defaults', async () => {
    settings = { defaults: custom, overrides: { a: { diskPercent: 10 } } }
    await publisher.publishHost('a')
    expect(publish).toHaveBeenCalledWith('a', { ...custom, diskPercent: 10 })
  })

  it('sends the built-in values when nothing is saved, so a stale retained config is replaced', async () => {
    await publisher.publishHost('a')
    expect(publish).toHaveBeenCalledWith('a', DEFAULT_THRESHOLDS)
  })

  it('rejects ids that are wildcards or extra topic levels without publishing', async () => {
    for (const bad of ['a/#', '+', '#', 'a/b', '..', '', 'x'.repeat(65)]) {
      await expect(publisher.publishHost(bad)).rejects.toThrow()
    }
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('publishAll', () => {
  it('sends the effective values to every known host', async () => {
    settings = { defaults: custom, overrides: { b: { cpuPercent: 99 } } }
    await publisher.publishAll()
    expect(publish).toHaveBeenCalledWith('a', custom)
    expect(publish).toHaveBeenCalledWith('b', { ...custom, cpuPercent: 99 })
  })

  it('keeps going when one publish fails', async () => {
    publish.mockRejectedValueOnce(new Error('broker down'))
    await expect(publisher.publishAll()).resolves.toBeUndefined()
    expect(publish).toHaveBeenCalledTimes(2)
  })
})

describe('onHostOnline', () => {
  it('sends nothing when no defaults or overrides were ever saved', async () => {
    await publisher.onHostOnline('a')
    expect(publish).not.toHaveBeenCalled()
  })

  it('sends the effective values once defaults are saved', async () => {
    settings = { defaults: custom, overrides: {} }
    await publisher.onHostOnline('new-host')
    expect(publish).toHaveBeenCalledWith('new-host', custom)
  })

  it('sends the effective values once only an override exists', async () => {
    settings = { defaults: null, overrides: { other: { diskPercent: 5 } } }
    await publisher.onHostOnline('a')
    expect(publish).toHaveBeenCalledWith('a', DEFAULT_THRESHOLDS)
  })
})
