/** Runs `fn`, retrying after `delayMs` on failure; the last error is thrown once `attempts` are used up. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts, delayMs, onRetry }: { attempts: number; delayMs: number; onRetry?: (err: unknown, attempt: number) => void }
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= attempts) throw err
      onRetry?.(err, attempt)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}
