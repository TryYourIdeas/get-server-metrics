import { describe, expect, it } from 'vitest'
import { resolveHost } from '../shared/server/utils/host'

describe('resolveHost', () => {
  it('uses the requested host when valid', () => {
    expect(resolveHost('web-01', ['a', 'b'])).toEqual({ ok: true, host: 'web-01' })
  })
  it('defaults to the first known host, or null when there are none', () => {
    expect(resolveHost(undefined, ['a', 'b'])).toEqual({ ok: true, host: 'a' })
    expect(resolveHost(undefined, [])).toEqual({ ok: true, host: null })
  })
  it('rejects hostile or malformed ids', () => {
    for (const h of ['a/b', '+', '#', '', 'x'.repeat(65), 5, ['a']]) expect(resolveHost(h, ['a'])).toEqual({ ok: false })
  })
})
