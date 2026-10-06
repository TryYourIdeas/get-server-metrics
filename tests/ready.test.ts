import { describe, expect, it, vi } from 'vitest'
import { memoizeUntilFailure } from '../server/utils/ready'

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
