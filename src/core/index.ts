// Entry point of the core utility process: the browsing engine, Jev, the Claude
// driver, the MCP server and local storage all live here, off the main process.
import { Rpc, type RpcMessage } from '../shared/rpc'

const port = process.parentPort
const main = new Rpc((m) => port.postMessage(m))
port.on('message', (e: { data: RpcMessage }) => main.receive(e.data))

async function start(): Promise<void> {
  const { boot } = await import('./boot')
  await boot(main)
}

start().catch((e) => {
  console.error('[brewse-core] failed to start', e)
})
