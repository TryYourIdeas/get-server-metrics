import { describe, expect, it, vi } from 'vitest'
import { withRetry } from '../server/utils/retry'

describe('withRetry', () => {
  it('retries until it succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('a')).mockResolvedValue('ok')
    expect(await withRetry(fn, { attempts: 3, delayMs: 1 })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('throws the last error after the attempts are used up', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'))
    await expect(withRetry(fn, { attempts: 2, delayMs: 1 })).rejects.toThrow('down')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
