import { getDb } from '../db'
import { runMigrations } from '../db/migrate'

/** Runs `fn` until it succeeds once; concurrent callers share the in-flight run, failures are not cached. */
export function memoizeUntilFailure(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    pending ??= fn().catch((err) => { pending = undefined; throw err })
    return pending
  }
}

/** Migrations are retried on every call until they succeed, so starting the app before Postgres is up self-heals. */
export const ensureDbReady = memoizeUntilFailure(() => runMigrations(getDb()))
