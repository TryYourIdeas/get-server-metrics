import { describe, expect, it } from 'vitest'
import { parseRange } from '../server/utils/range'

describe('parseRange', () => {
  it('defaults to 1h when missing', () => expect(parseRange(undefined)).toBe('1h'))
  it('accepts valid ranges', () => { expect(parseRange('24h')).toBe('24h'); expect(parseRange('7d')).toBe('7d') })
  it('returns null for invalid values', () => { expect(parseRange('1y')).toBeNull(); expect(parseRange(['1h'])).toBeNull() })
})
