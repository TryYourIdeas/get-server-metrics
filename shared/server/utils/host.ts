import { isValidHostId } from 'agent/protocol'

/** Picks the host a request is about: the given one if valid, else the first known host (null when none exist yet). */
export function resolveHost(raw: unknown, known: string[]): { ok: true; host: string | null } | { ok: false } {
  if (raw === undefined) return { ok: true, host: known[0] ?? null }
  return isValidHostId(raw) ? { ok: true, host: raw } : { ok: false }
}
