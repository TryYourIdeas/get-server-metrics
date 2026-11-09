import { describe, expect, it } from 'vitest'
import { fieldsFrom, parseDefaultsForm, parseOverrideForm, type ThresholdFields } from '../dashboard/app/utils/thresholds-form'

const filled: ThresholdFields = { cpuPercent: '90', cpuConsecutive: '3', memoryPercent: '85', diskPercent: '80' }
const blank: ThresholdFields = { cpuPercent: '', cpuConsecutive: '', memoryPercent: '', diskPercent: '' }

describe('parseDefaultsForm', () => {
  it('returns typed numbers for a valid form and trims whitespace', () => {
    expect(parseDefaultsForm({ ...filled, memoryPercent: ' 70.5 ' })).toEqual({
      ok: true, value: { cpuPercent: 90, cpuConsecutive: 3, memoryPercent: 70.5, diskPercent: 80 }
    })
  })

  it('requires every field', () => {
    const r = parseDefaultsForm({ ...filled, diskPercent: '' })
    expect(r).toMatchObject({ ok: false, errors: { diskPercent: expect.any(String) } })
  })

  it('rejects text, zero, over 100 and fractional consecutive checks, with a message per field', () => {
    const r = parseDefaultsForm({ cpuPercent: 'abc', cpuConsecutive: '1.5', memoryPercent: '0', diskPercent: '101' })
    expect(r).toEqual({
      ok: false,
      errors: {
        cpuPercent: 'Enter a number between 1 and 100',
        cpuConsecutive: 'Enter a whole number, 1 or more',
        memoryPercent: 'Enter a number between 1 and 100',
        diskPercent: 'Enter a number between 1 and 100'
      }
    })
  })
})

describe('parseOverrideForm', () => {
  it('omits blank fields and keeps the filled ones', () => {
    expect(parseOverrideForm({ ...blank, diskPercent: '50', cpuConsecutive: '5' })).toEqual({ ok: true, value: { cpuConsecutive: 5, diskPercent: 50 } })
  })

  it('returns null when every field is blank, meaning "use the defaults"', () => {
    expect(parseOverrideForm(blank)).toEqual({ ok: true, value: null })
    expect(parseOverrideForm({ cpuPercent: ' ', cpuConsecutive: '', memoryPercent: '  ', diskPercent: '' })).toEqual({ ok: true, value: null })
  })

  it('still validates the filled fields', () => {
    expect(parseOverrideForm({ ...blank, cpuPercent: '150' })).toEqual({ ok: false, errors: { cpuPercent: 'Enter a number between 1 and 100' } })
  })
})

describe('fieldsFrom', () => {
  it('turns numbers into strings and missing values into blanks', () => {
    expect(fieldsFrom({ cpuPercent: 80, diskPercent: 50.5 })).toEqual({ cpuPercent: '80', cpuConsecutive: '', memoryPercent: '', diskPercent: '50.5' })
    expect(fieldsFrom(null)).toEqual(blank)
    expect(fieldsFrom(undefined)).toEqual(blank)
  })
})
