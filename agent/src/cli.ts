import { startAgent } from './agent'
import { configWarnings, readAgentConfig } from './config'
import { logError } from './log'

try {
  const config = readAgentConfig(process.env)
  for (const w of configWarnings(config)) logError(w)
  const agent = startAgent(config)
  const shutdown = () => { void agent.stop().finally(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (err) {
  logError('agent failed to start', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
}
