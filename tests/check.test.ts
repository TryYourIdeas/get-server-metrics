import { describe, expect, it, vi } from 'vitest'
import { createCheckRequester } from '../server/utils/check'

describe('createCheckRequester', () => {
  it('publishes a request with a fresh id', async () => {
    const publish = vi.fn().mockResolvedValue(undefined)
    const check = createCheckRequester({ publish, newId: () => 'id-1' })
    expect(await check('h1')).toEqual({ ok: true, requestId: 'id-1' })
    expect(publish).toHaveBeenCalledWith('h1', 'id-1')
  })
  it('refuses a second request for the same host within the cooldown, but not for other hosts or later', async () => {
    let t = 1000
    const publish = vi.fn().mockResolvedValue(undefined)
    const check = createCheckRequester({ publish, now: () => t, cooldownMs: 2000 })
    expect((await check('h1')).ok).toBe(true)
    expect(await check('h1')).toEqual({ ok: false, reason: 'cooldown' })
    expect((await check('h2')).ok).toBe(true)
    t += 2001
    expect((await check('h1')).ok).toBe(true)
    expect(publish).toHaveBeenCalledTimes(3)
  })
  it('does not start a cooldown when publishing fails', async () => {
    const publish = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined)
    const check = createCheckRequester({ publish })
    await expect(check('h1')).rejects.toThrow('down')
    expect((await check('h1')).ok).toBe(true)
  })
})
