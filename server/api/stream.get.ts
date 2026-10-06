import { createEventStream } from 'h3'
import { bus } from '../utils/bus'
import { logDebug } from '../utils/log'
import { isBrokerConnected } from '../utils/mqtt'

const PING_MS = 25_000

export default defineEventHandler(async (event) => {
  const stream = createEventStream(event)
  const unsubscribe = bus.subscribe((e) => { void stream.push(JSON.stringify(e)) })
  const ping = setInterval(() => void stream.push(JSON.stringify({ type: 'ping' })), PING_MS)
  stream.onClosed(async () => {
    clearInterval(ping)
    unsubscribe()
    logDebug('stream closed')
    await stream.close()
  })
  logDebug('stream opened')
  void stream.push(JSON.stringify({ type: 'broker', connected: isBrokerConnected() }))
  return stream.send()
})
