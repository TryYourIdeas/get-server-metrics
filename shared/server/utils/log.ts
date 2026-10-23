const debugOn = () => ['true', '1'].includes(process.env.NUXT_ADD_DEBUG_LOGS ?? '')
const fmt = (level: string, msg: string, ctx?: Record<string, unknown>) =>
  `[computer-usage] ${new Date().toISOString()} ${level} ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}`

export const logInfo = (msg: string, ctx?: Record<string, unknown>) => console.log(fmt('INFO', msg, ctx))
export const logError = (msg: string, ctx?: Record<string, unknown>) => console.error(fmt('ERROR', msg, ctx))
export const logDebug = (msg: string, ctx?: Record<string, unknown>) => { if (debugOn()) console.log(fmt('DEBUG', msg, ctx)) }
