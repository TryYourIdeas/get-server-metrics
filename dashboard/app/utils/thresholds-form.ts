import { isValidThreshold, THRESHOLD_KEYS, type Thresholds } from 'agent/protocol'

export type ThresholdFields = Record<keyof Thresholds, string>
export type FormResult<T> = { ok: true; value: T } | { ok: false; errors: Partial<Record<keyof Thresholds, string>> }

const MESSAGES: Record<keyof Thresholds, string> = {
  cpuPercent: 'Enter a number between 1 and 100',
  cpuConsecutive: 'Enter a whole number, 1 or more',
  memoryPercent: 'Enter a number between 1 and 100',
  diskPercent: 'Enter a number between 1 and 100'
}

/** Form fields (all strings) for a possibly partial set of values; a missing value is a blank field. */
export function fieldsFrom(t: Partial<Thresholds> | null | undefined): ThresholdFields {
  const out = {} as ThresholdFields
  for (const key of THRESHOLD_KEYS) out[key] = t?.[key] === undefined ? '' : String(t[key])
  return out
}

function parseFields(f: ThresholdFields, allowBlank: boolean): FormResult<Partial<Thresholds>> {
  const value: Partial<Thresholds> = {}
  const errors: Partial<Record<keyof Thresholds, string>> = {}
  for (const key of THRESHOLD_KEYS) {
    const raw = f[key].trim()
    if (raw === '') {
      if (!allowBlank) errors[key] = MESSAGES[key]
      continue
    }
    const n = Number(raw)
    if (isValidThreshold(key, n)) value[key] = n
    else errors[key] = MESSAGES[key]
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value }
}

/** The default set: every field is required. */
export function parseDefaultsForm(f: ThresholdFields): FormResult<Thresholds> {
  const r = parseFields(f, false)
  return r.ok ? { ok: true, value: r.value as Thresholds } : r
}

/** A server's override: blank fields use the default; all blank means "no override" (null). */
export function parseOverrideForm(f: ThresholdFields): FormResult<Partial<Thresholds> | null> {
  const r = parseFields(f, true)
  if (!r.ok) return r
  return { ok: true, value: Object.keys(r.value).length ? r.value : null }
}
