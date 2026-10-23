import { Aedes } from 'aedes'
import net from 'node:net'

export async function startBroker(port = 0) {
  const broker = await Aedes.createBroker()
  const server = net.createServer(broker.handle)
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r))
  const boundPort = (server.address() as net.AddressInfo).port
  return {
    port: boundPort,
    url: `mqtt://127.0.0.1:${boundPort}`,
    async stop() {
      await new Promise<void>(r => broker.close(() => r()))
      await new Promise<void>(r => server.close(() => r()))
    }
  }
}

export async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const p = (s.address() as net.AddressInfo).port
  await new Promise<void>(r => s.close(() => r()))
  return p
}
