import { describe, expect, it, vi } from 'vitest'
import { createPruner, parseRetentionDays } from '../server/utils/retention'

describe('parseRetentionDays', () => {
  it('defaults to 30 when unset, empty or invalid', () => {
    expect(parseRetentionDays(undefined)).toBe(30)
    expect(parseRetentionDays('')).toBe(30)
    expect(parseRetentionDays('abc')).toBe(30)
    expect(parseRetentionDays('-5')).toBe(30)
  })
  it('accepts a number of days and 0 (disabled)', () => {
    expect(parseRetentionDays('7')).toBe(7)
    expect(parseRetentionDays('0')).toBe(0)
  })
})

describe('createPruner', () => {
  const now = () => new Date('2026-02-01T00:00:00Z')
  it('prunes samples older than the retention window', async () => {
    const prune = vi.fn().mockResolvedValue(3)
    expect(await createPruner({ retentionDays: 10, prune, now })()).toBe(3)
    expect(prune).toHaveBeenCalledWith(new Date('2026-01-22T00:00:00Z'))
  })
  it('does nothing when retention is 0', async () => {
    const prune = vi.fn()
    expect(await createPruner({ retentionDays: 0, prune, now })()).toBeUndefined()
    expect(prune).not.toHaveBeenCalled()
  })
  it('logs and swallows failures, and skips pruning if not ready', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prune = vi.fn()
    const run = createPruner({ retentionDays: 5, prune, now, ensureReady: () => Promise.reject(new Error('db down')) })
    expect(await run()).toBeUndefined()
    expect(prune).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('prune failed'))
    err.mockRestore()
  })
})
