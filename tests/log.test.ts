import { afterEach, describe, expect, it, vi } from 'vitest'
import { logDebug } from '../server/utils/log'

afterEach(() => { vi.restoreAllMocks(); delete process.env.NUXT_ADD_DEBUG_LOGS })

describe('logDebug', () => {
  it('prints via console.log (visible under Nitro) when NUXT_ADD_DEBUG_LOGS=true', () => {
    process.env.NUXT_ADD_DEBUG_LOGS = 'true'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logDebug('hello', { a: 1 })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toContain('DEBUG hello {"a":1}')
  })
  it('prints nothing when the flag is off', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logDebug('hello')
    expect(spy).not.toHaveBeenCalled()
  })
})
