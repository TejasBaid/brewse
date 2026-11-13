import type { Rpc } from '../shared/rpc'
import { BrowserHost } from './browser/host'
import { Engine } from './engine'
import { Jev } from './jev/client'
import { Trust } from './jev/trust'
import { startMcpServer } from './mcp'
import { Routines } from './routines'
import { Store } from './store'
import { Tasks } from './tasks'
import { buildTools } from './tools'

export async function boot(main: Rpc): Promise<void> {
  const info = await main.call<{ userData: string; headless: boolean; version: string; workRoot: string }>('app.info')
  const ui = (channel: string, data: unknown) => main.emit('ui', { channel, data })

  const store = new Store(info.userData)
  const jev = new Jev(process.env['JEV_API_KEY'])
  const trust = new Trust(store)
  const host = new BrowserHost(main)
  const engine = new Engine(host, store, jev, trust)
  const routines = new Routines(engine, store, (event) => ui('core:routine', event))
  const tools = buildTools(engine, routines)

  // History and address-bar suggestions.
  main.on('history.visit', ({ url, title }) => store.visit(url, title))
  main.on('history.title', ({ url, title }) => store.retitle(url, title))
  main.handle('omnibox.query', ({ q, limit }) => store.suggest(q, limit))
  main.handle('history.recent', ({ limit }) => store.recent(limit))

  // Settings the UI can read and change.
  main.handle('settings.get', ({ key, fallback }) => store.get(key, fallback))
  main.handle('settings.set', ({ key, value }) => store.set(key, value))
  main.handle('trust.summary', () => ({ rows: trust.summary(), jev: { available: jev.available, calls: jev.calls, cost: jev.cost, avgMs: jev.calls ? Math.round(jev.totalMs / jev.calls) : 0 } }))
  main.handle('routines.list', () => routines.list())

  // Every task is kept, so it can be found again after it is closed, and after Brewse is.
  const tasks = new Tasks(store.db)
  main.handle('tasks.list', () => tasks.list())
  main.handle('tasks.get', ({ id }) => tasks.get(id) ?? null)
  main.handle('tasks.remove', ({ id }) => tasks.remove(id))
  main.handle('tasks.clear', () => tasks.clear())
  // The window's own test plays a task's events back without calling a model; this is how they reach the record.
  main.handle('tasks.record', (e) => tasks.record(e))
  // And this lets it check the file rules without a task having to try each case.
  main.handle('files.judge', async ({ read, write }: { read: string[]; write: string[] }) => {
    const { judgeRead, judgeWrite } = await import('./files')
    const policy = { workDir: `${info.workRoot}/Example task`, agentDir: `${info.userData}/agent` }
    return { read: read.map((p) => judgeRead(p, policy).verdict), write: write.map((p) => judgeWrite(p, policy, new Set()).verdict) }
  })

  const { startAgent } = await import('./agent/driver')
  startAgent({ main, engine, tools, tasks, workRoot: info.workRoot, ui })

  const port = await startMcpServer(engine, tools, info.version)
  routines.startScheduler()
  main.emit('ready')
  console.log(`[brewse-core] up (v${info.version}${info.headless ? ', headless' : ''}); MCP at http://127.0.0.1:${port}/mcp; Jev ${jev.available ? 'ready' : 'not configured'}`)
}
