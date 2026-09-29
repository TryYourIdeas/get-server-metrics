import { describe, expect, it, vi } from 'vitest'
import { createTick, memoizeUntilFailure } from '../server/utils/sampler'

const metrics = { cpuPercent: 1, memUsed: 1, memTotal: 2, disks: [] }

describe('createTick', () => {
  it('collects then saves and returns true', async () => {
    const save = vi.fn().mockResolvedValue(1)
    const tick = createTick({ collect: async () => metrics, save })
    expect(await tick()).toBe(true)
    expect(save).toHaveBeenCalledWith(metrics)
  })
  it('returns false and does not throw when save fails; next tick still runs', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(1)
    const tick = createTick({ collect: async () => metrics, save })
    expect(await tick()).toBe(false)
    expect(await tick()).toBe(true)
  })
  it('returns false when collect throws', async () => {
    const tick = createTick({ collect: async () => { throw new Error('boom') }, save: vi.fn() })
    expect(await tick()).toBe(false)
  })
  it('skips a tick while the previous one is still running', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const save = vi.fn().mockResolvedValue(1)
    const tick = createTick({ collect: async () => { await gate; return metrics }, save })
    const first = tick()
    expect(await tick()).toBe(false)
    release()
    expect(await first).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('createTick ensureReady', () => {
  it('retries the readiness step on every tick until it succeeds', async () => {
    const ensureReady = vi.fn().mockRejectedValueOnce(new Error('db starting')).mockResolvedValue(undefined)
    const save = vi.fn().mockResolvedValue(1)
    const tick = createTick({ ensureReady, collect: async () => metrics, save })
    expect(await tick()).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(await tick()).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('memoizeUntilFailure', () => {
  it('runs once on success and again after a failure', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined)
    const once = memoizeUntilFailure(fn)
    await expect(once()).rejects.toThrow('x')
    await once()
    await once()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
