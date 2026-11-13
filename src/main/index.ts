import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, nativeTheme, shell as shell_, utilityProcess } from 'electron'
import { Rpc, type RpcMessage } from '../shared/rpc'
import { DEFAULT_PROFILE, type CreateTabOptions, type Layout, type OverlayMode, type TabsState } from '../shared/protocol'
import { installAdblock } from './adblock'
import { loadDotEnv } from './env'
import { installMenu } from './menu'
import { Shell } from './shell'
import { TabManager } from './tabs'
import { looksLikeUrl } from './url'

const outDir = import.meta.dirname
const argv = process.argv.slice(1)
const headless = argv.includes('--headless')
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const shotPath = flag('shot')
let quitting = false
const selfTest = process.argv.some((a) => a === '--selftest' || a.startsWith('--selftest='))
const startUrl = flag('url')
const PANEL_WIDTH = 400

if (flag('user-data')) app.setPath('userData', flag('user-data')!)
// A capture run keeps drawing when other windows cover it; otherwise the capture waits until it is uncovered.
if (shotPath || selfTest) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}
app.setName('Brewse')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  loadDotEnv([process.cwd(), app.getAppPath(), app.getPath('userData')])
  if (headless) app.dock?.hide()
  await app.whenReady()
  const theme = flag('theme')
  if (theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme

  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })

  const shell = new Shell({ headless, outDir, quiet: (!!shotPath || selfTest) && !argv.includes('--stay') })
  const tabs = new TabManager(shell, { prepareSession: (ses, profile) => installAdblock(ses, profile, userData) })
  shell.onLayout = () => tabs.relayout()

  // ---- core process ----------------------------------------------------------
  const coreProc = utilityProcess.fork(join(outDir, 'core.js'), [], {
    serviceName: 'Brewse Core',
    stdio: 'inherit',
    env: { ...process.env, BREWSE_USER_DATA: userData, BREWSE_HEADLESS: headless ? '1' : '', BREWSE_APP_ROOT: app.getAppPath() },
  })
  const core = new Rpc((m) => coreProc.postMessage(m))
  coreProc.on('message', (m: RpcMessage) => core.receive(m))
  const coreReady = new Promise<void>((resolve) => core.on('ready', () => resolve()))
  coreProc.on('exit', (code) => console.error(`[brewse] core process exited with code ${code}`))

  core.handle('tabs.create', (o: CreateTabOptions) => tabs.create(o))
  core.handle('tabs.close', ({ id }) => tabs.close(id))
  core.handle('tabs.list', () => tabs.state())
  core.handle('tabs.get', ({ id }) => tabs.info(id) ?? null)
  core.handle('tabs.activate', ({ id }) => tabs.activate(id))
  core.handle('tabs.navigate', ({ id, url }) => tabs.navigate(id, url))
  core.handle('tabs.back', ({ id }) => tabs.back(id))
  core.handle('tabs.forward', ({ id }) => tabs.forward(id))
  core.handle('tabs.reload', ({ id }) => tabs.reload(id))
  core.handle('tabs.setBusy', ({ id, busy }) => tabs.setBusy(id, busy))
  core.handle('tabs.capture', async ({ id, rect }) => {
    const image = await tabs.webContents(id).capturePage(rect, { stayHidden: true })
    return image.toJPEG(70).toString('base64')
  })
  core.handle('cdp.attach', ({ id }) => tabs.attachDebugger(id))
  core.handle('cdp.send', ({ id, method, params, sessionId }) => tabs.cdp(id, method, params, sessionId))
  // Tasks keep the files they make in ~/Brewse, one folder each. A profile given on the command line keeps them inside that profile.
  const workRoot = process.env['BREWSE_WORK_DIR'] ?? (flag('user-data') ? join(userData, 'Tasks') : join(app.getPath('home'), 'Brewse'))
  core.handle('app.info', () => ({ userData, headless, version: app.getVersion(), activeTab: tabs.activeId, workRoot }))
  // Test windows only: answer every question a task asks with yes, so a capture run can reach its end.
  // Never honoured in a normal window, where the user must be the one to answer.
  const testApprove = argv.includes('--test-approve-all') && (!!shotPath || selfTest)
  core.on('ui', ({ channel, data }) => {
    if (testApprove && channel === 'core:agent' && data?.type === 'approval') setTimeout(() => void core.call('agent.approve', { session: data.session, id: data.id, allow: true }).catch(() => {}), 1500)
    if (process.env['BREWSE_TIMING'] && channel === 'core:agent' && !['text', 'thinking'].includes(data?.type)) console.log('[brewse] agent', JSON.stringify(data).slice(0, 200))
    shell.send(channel, data)
  })

  tabs.on('cdp', (e) => core.emit('cdp', e))
  tabs.on('cdp-detached', (e) => core.emit('cdp.detached', e))
  tabs.on('closed', (id) => {
    core.emit('tab.closed', { id })
    // The window always has a tab: closing the last one leaves a new, empty one.
    if (!quitting && !shell.win.isDestroyed() && shell.win.isVisible() && !tabs.state().tabs.some((t) => t.owner === 'user')) setImmediate(() => actions.newTab())
  })
  tabs.on('opened', (e) => core.emit('tab.opened', e))
  tabs.on('visit', (e) => core.emit('history.visit', e))
  tabs.on('title', (e) => core.emit('history.title', e))
  tabs.on('changed', (state: TabsState) => {
    shell.send('tabs:state', state)
    saveSession(userData, state)
  })

  // ---- UI bridge -------------------------------------------------------------
  const setPanel = (open: boolean) => shell.setLayout({ panel: open ? PANEL_WIDTH : 0 })
  const actions = {
    togglePanel: () => setPanel(shell.layout.panel === 0),
    ask: () => openDock(),
    /** A new tab is a tab: it opens on the start page with the address field ready. */
    newTab: () => {
      shell.hideOverlay()
      // One empty tab is enough; asking again goes back to it.
      const empty = tabs.state().tabs.find((t) => t.owner === 'user' && tabs.isBlank(t.id))
      if (empty) tabs.activate(empty.id)
      else tabs.create({})
      shell.ui.webContents.focus()
      shell.ui.webContents.send('app:focus-address', {})
    },
    /** Edit the address of the tab in view. */
    address: () => {
      if (shell.layout.mode === 'browse' && tabs.isBlank(tabs.activeId)) {
        shell.ui.webContents.focus()
        shell.ui.webContents.send('app:focus-address', {})
      } else if (shell.layout.mode === 'browse' && tabs.activeId) {
        // The window knows where the tab's word is; it asks for the field to open there.
        shell.ui.webContents.send('app:edit-address', {})
      } else actions.newTab()
    },
    overview: async () => {
      // Take a fresh picture of the page in view before it gives way to the overview.
      if (shell.layout.mode === 'browse') await tabs.snapshot(tabs.activeId)
      shell.setLayout(shell.layout.mode === 'overview' ? { mode: 'browse' } : { mode: 'overview', panel: 0, peek: null })
      shell.ui.webContents.focus()
    },
    /** Every task there has been: running, finished and put away. */
    tasks: () => {
      shell.hideOverlay()
      shell.setLayout(shell.layout.mode === 'tasks' ? { mode: 'browse' } : { mode: 'tasks', panel: 0, peek: null })
      shell.ui.webContents.focus()
    },
    settings: () => shell.ui.webContents.send('app:settings', {}),
  }

  ipcMain.handle('tabs:state', () => tabs.state())
  ipcMain.handle('tabs:create', (_e, o: CreateTabOptions) => tabs.create(o ?? {}))
  ipcMain.handle('tabs:close', (_e, id: string) => tabs.close(id))
  ipcMain.handle('tabs:activate', (_e, id: string) => tabs.activate(id))
  ipcMain.handle('tabs:navigate', (_e, { id, input }: { id?: string; input: string }) => {
    const target = id ?? tabs.activeId
    if (target) tabs.navigate(target, input)
    else tabs.create({ url: input })
  })
  ipcMain.handle('tabs:back', (_e, id?: string) => tabs.back(id ?? tabs.activeId!))
  ipcMain.handle('tabs:forward', (_e, id?: string) => tabs.forward(id ?? tabs.activeId!))
  ipcMain.handle('tabs:reload', (_e, id?: string) => tabs.reload(id ?? tabs.activeId!))
  ipcMain.handle('tabs:stop', (_e, id?: string) => tabs.stop(id ?? tabs.activeId!))
  ipcMain.handle('layout:get', () => shell.layout)
  ipcMain.handle('layout:set', (_e, patch: Partial<Layout>) => shell.setLayout(patch))
  ipcMain.handle('overlay:open', (_e, { mode, anchor }: { mode: OverlayMode; anchor?: { x: number; y: number; width: number; height: number } }) => {
    if (mode === 'new-tab') return actions.newTab()
    if (mode === 'address') {
      if (tabs.isBlank(tabs.activeId) || !tabs.activeId) return actions.address()
      return shell.showOverlay('address', { url: tabs.active()?.info.url ?? '', anchor })
    }
    shell.showOverlay(mode, {})
  })
  ipcMain.handle('tabs:new', () => actions.newTab())
  // A local record of where clicks landed in the interface, for checking a report that a control did nothing.
  // Only kept when running from source, and never more than a few hundred lines.
  const clickLog = join(userData, 'clicks.log')
  ipcMain.handle('app:click-log', (_e, line: string) => {
    if (app.isPackaged || typeof line !== 'string') return
    try {
      if (existsSync(clickLog) && statSync(clickLog).size > 60_000) writeFileSync(clickLog, '')
      appendFileSync(clickLog, `${new Date().toISOString()} ${line.slice(0, 200)}\n`)
    } catch {}
  })
  ipcMain.handle('overlay:close', () => {
    shell.hideOverlay()
    tabs.active()?.view?.webContents.focus()
  })
  ipcMain.handle('overlay:submit', (_e, s: { kind: string; text?: string; url?: string; tabId?: string; mode: OverlayMode }) => {
    shell.hideOverlay()
    if (s.kind === 'tab' && s.tabId) return tabs.activate(s.tabId)
    if (s.kind === 'ask') {
      // With the side panel or chat on screen the conversation is already visible; otherwise the dock carries it.
      if (shell.layout.mode === 'chat' || shell.layout.panel > 0) shell.ui.webContents.send('app:ask', { prompt: s.text ?? '' })
      else shell.overlay.webContents.send('dock:run', { prompt: s.text ?? '' })
      return
    }
    const input = s.url ?? s.text ?? ''
    if (s.mode === 'address' && tabs.activeId) tabs.navigate(tabs.activeId, input)
    else tabs.create({ url: input })
  })
  // The dock is the main way to give a task: a field that rises from the bottom of the page.
  const openDock = (scope?: 'task') => {
    // From the overview, asking goes back to the page first: the field belongs to the page.
    if (shell.layout.mode === 'overview' || shell.layout.mode === 'tasks') shell.setLayout({ mode: 'browse' })
    if (shell.layout.mode === 'chat') {
      // In chat mode the composer is already on screen.
      shell.ui.webContents.focus()
      shell.ui.webContents.send('app:focus-composer', {})
    } else shell.overlay.webContents.send('dock:show', { scope })
  }
  shell.onDockHidden = () => {
    if (!shell.overlayOpen) tabs.active()?.view?.webContents.focus()
  }
  ipcMain.handle('dock:open', (_e, p?: { scope?: 'task' }) => openDock(p?.scope))
  ipcMain.handle('dock:size', (_e, spec: { px?: number; fraction?: number; focus?: boolean }) => {
    if (process.env['BREWSE_TIMING']) console.log('[brewse] dock size', JSON.stringify(spec))
    shell.sizeDock(spec ?? {})
  })
  ipcMain.handle('core:call', async (_e, { method, params }: { method: string; params?: unknown }) => {
    // The core starts a moment after the window; early calls wait for it.
    await coreReady
    return core.call(method, params)
  })
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), headless, activeTab: tabs.activeId }))
  ipcMain.handle('app:window', (_e, action: 'close' | 'minimize' | 'zoom') => shell.windowAction(action))
  // Open a task as a place: its conversation fills the card and its tab floats beside it.
  ipcMain.handle('app:open-task', (_e, { id, peeks }: { id: string; peeks?: string[] }) => {
    shell.setLayout({ mode: 'chat', panel: 0, peeks: peeks ?? [] })
    shell.send('app:open-task', { id })
    shell.ui.webContents.focus()
  })
  // A conversation that belongs to a page opens beside that page.
  ipcMain.handle('app:open-thread', (_e, { id, tab }: { id: string; tab: string }) => {
    if (tabs.get(tab)) tabs.activate(tab)
    shell.setLayout({ mode: 'browse', panel: PANEL_WIDTH })
    shell.send('app:open-thread', { id })
  })
  // Reading a result in one layer marks it read in the other.
  ipcMain.handle('app:seen', (_e, id: string) => shell.send('app:seen', { id }))
  ipcMain.handle('app:overview', () => actions.overview())
  ipcMain.handle('app:tasks', () => actions.tasks())
  // Files a task has made: open one, or show it in Finder. Only things that exist, and only by full path.
  ipcMain.handle('app:reveal', (_e, path: string) => {
    if (typeof path === 'string' && path.startsWith('/') && existsSync(path)) shell_.showItemInFolder(path)
  })
  ipcMain.handle('app:open-file', (_e, path: string) => {
    if (typeof path !== 'string' || !path.startsWith('/') || !existsSync(path)) return
    // Pages open in a tab, where they can be looked at; everything else opens in its own application.
    if (/\.(html?|pdf|svg|png|jpe?g|gif|webp|txt|md|json|csv)$/i.test(path)) tabs.create({ url: `file://${encodeURI(path)}` })
    else void shell_.openPath(path)
  })
  ipcMain.handle('app:settings', () => actions.settings())

  // Pictures of the pages you have been to, kept by address for the new tab page.
  const thumbDir = join(userData, 'thumbs')
  const thumbFile = (url: string) => join(thumbDir, `${createHash('sha1').update(url).digest('hex')}.jpg`)
  const thumbSaved = new Map<string, number>()
  tabs.on('thumb', ({ url, jpeg }: { url: string; jpeg: Buffer }) => {
    if (headless || Date.now() - (thumbSaved.get(url) ?? 0) < 60_000) return
    thumbSaved.set(url, Date.now())
    try {
      mkdirSync(thumbDir, { recursive: true })
      writeFileSync(thumbFile(url), jpeg)
    } catch {}
  })
  ipcMain.handle('app:thumbs', (_e, urls: string[]) => {
    const out: Record<string, string> = {}
    for (const url of Array.isArray(urls) ? urls.slice(0, 24) : []) {
      try {
        if (existsSync(thumbFile(url))) out[url] = `data:image/jpeg;base64,${readFileSync(thumbFile(url)).toString('base64')}`
      } catch {}
    }
    return out
  })
  ipcMain.handle('tabs:thumbs', () => Object.fromEntries(tabs.thumbs))
  ipcMain.handle('app:classify', (_e, text: string) => ({ url: looksLikeUrl(text) }))

  installMenu(shell, tabs, actions)

  // ---- startup tabs ----------------------------------------------------------
  if (!headless) {
    const restored = startUrl ? null : loadSession(userData)
    if (restored && restored.tabs.length) {
      // Only the active tab loads; the rest stay asleep until clicked.
      const infos = restored.tabs.map((t) => tabs.createAsleep(t.url, t.title))
      tabs.activate(infos[Math.min(restored.active, infos.length - 1)].id)
    } else {
      tabs.create(startUrl ? { url: startUrl } : {})
      // Development aid: open several tabs at once.
      for (const extra of (flag('urls') ?? '').split(',').filter(Boolean)) tabs.create({ url: extra, activate: false })
    }
    setInterval(() => tabs.sleepIdle(30 * 60_000), 5 * 60_000)
    // Keep the picture of the page in view reasonably fresh for the overview.
    setInterval(() => shell.layout.mode === 'browse' && shell.win.isFocused() && void tabs.snapshot(tabs.activeId), 8000)
  }

  // Opening Brewse while a headless one is serving coding sessions turns that one into the visible app.
  let revealed = !headless
  app.on('second-instance', () => {
    if (!revealed) {
      revealed = true
      void app.dock?.show()
      if (!tabs.state().tabs.some((t) => t.owner === 'user')) tabs.create({})
    }
    shell.win.show()
    shell.win.focus()
  })
  app.on('window-all-closed', () => app.quit())
  shell.win.on('close', () => (quitting = true))
  shell.win.on('closed', () => app.quit())
  app.on('before-quit', () => {
    quitting = true
    coreProc.kill()
  })

  // Development aid: carry on the most recent stored task with a new message.
  const continueWith = flag('continue-latest')
  if (continueWith) setTimeout(() => shell.ui.webContents.send('app:dev-continue', { prompt: continueWith }), 3500)

  // Development aid: start an agent task at launch.
  const askPrompt = flag('ask')
  if (askPrompt) {
    setTimeout(() => {
      // `--ask-scope=page` asks on the page in view; `--ask-then=` follows up on the same page once the first answer is in.
      if (flag('ask-scope') === 'page') {
        shell.overlay.webContents.send('dock:dev-ask', { prompt: askPrompt, scope: 'page' })
        const then = flag('ask-then')
        if (then) {
          let sent = false
          core.on('ui', ({ channel, data }) => {
            if (sent || channel !== 'core:agent' || data?.type !== 'done') return
            sent = true
            setTimeout(() => shell.overlay.webContents.send('dock:dev-ask', { prompt: then, scope: 'page' }), 800)
          })
        }
        return
      }
      if (flag('mode') === 'dock') return shell.overlay.webContents.send('dock:run', { prompt: askPrompt })
      setPanel(true)
      shell.ui.webContents.send('app:ask', { prompt: askPrompt })
    }, 3000)
  }

  if (selfTest) {
    // Development aid: click through the window and check that each step did what was asked.
    void import('./selftest').then(async ({ selftest }) => {
      const failed = await selftest(shell, tabs, core, flag('selftest') === 'restore' ? 'restore' : 'all').catch((e) => {
        console.log(`FAIL  selftest stopped: ${(e as Error).stack ?? e}`)
        return 1
      })
      app.exit(failed ? 1 : 0)
    })
  }

  if (shotPath) {
    // Development aid: write PNGs of the UI layer and the active page, then quit.
    // The UI draws the page capture into the card so one image shows the whole window.
    let shot = false
    const takeShot = async () => {
      if (shot) return
      shot = true
      if (flag('shot-do') === 'panel') setPanel(true)
      if (flag('shot-do') === 'ask') openDock()
      if (flag('shot-do') === 'newtab') {
        actions.newTab()
        if (flag('shot-text')) setTimeout(() => shell.ui.webContents.send('app:dev-type', { text: flag('shot-text') }), 300)
        await new Promise((r) => setTimeout(r, 900))
      }
      if (flag('shot-do') === 'overview') await actions.overview()
      if (flag('shot-do') === 'tasks') {
        actions.tasks()
        await new Promise((r) => setTimeout(r, 700))
      }
      if (flag('shot-do') === 'address') {
        actions.address()
        await new Promise((r) => setTimeout(r, 600))
      }
      if (flag('shot-do') === 'detail') shell.overlay.webContents.send('dock:dev-hover', {})
      await new Promise((r) => setTimeout(r, 500))
      // The overview has no live page on screen, so there is nothing to draw in.
      const page = shell.layout.mode === 'overview' || shell.layout.mode === 'tasks' || (shell.layout.mode === 'browse' && tabs.isBlank(tabs.activeId)) ? undefined : (shell.layout.mode === 'chat' && shell.layout.peek ? tabs.get(shell.layout.peek) : tabs.active())?.view
      const pageShot = page ? (await page.webContents.capturePage()).toDataURL() : null
      const target = shell.overlayOpen || flag('shot-layer') === 'dock' ? shell.overlay : shell.ui
      target.webContents.send('app:devshot', { page: pageShot, card: flag('shot-layer') === 'dock' ? shell.dockOffset(shell.cardBounds()) : shell.cardBounds() })
      // A task view has more live pages than the large one: draw the small ones in as well.
      if (shell.layout.mode === 'chat' && target === shell.ui) {
        for (const tile of shell.tiles().slice(1)) {
          const view = tabs.get(tile.id)?.view
          if (view) target.webContents.send('app:devshot', { page: (await view.webContents.capturePage()).toDataURL(), card: shell.tileView(tile) })
        }
      }
      await new Promise((r) => setTimeout(r, 700))
      writeFileSync(shotPath, (await target.webContents.capturePage()).toPNG())
      if (!argv.includes('--stay')) app.quit()
    }
    // `--shot-on=result` waits for the dock's result sheet instead of a fixed delay.
    if (flag('shot-on') === 'result') shell.onDockSized = (spec) => spec.fraction === 0.5 && setTimeout(takeShot, 1500)
    // `--shot-on=task` goes on from the result into the task view and captures that.
    if (flag('shot-on') === 'task') {
      shell.onDockSized = (spec) => {
        if (spec.fraction !== 0.5) return
        shell.overlay.webContents.send('dock:dev-open', {})
        setTimeout(takeShot, 2600)
      }
    }
    // `--shot-on=done` waits for the task started with `--ask` to finish.
    if (flag('shot-on') === 'done') core.on('ui', ({ channel, data }) => channel === 'core:agent' && data?.type === 'done' && setTimeout(takeShot, 1500))
    setTimeout(takeShot, Number(flag('shot-delay') ?? 4000))
  }
}

interface SavedSession {
  tabs: { url: string; title: string }[]
  active: number
}

let saveTimer: NodeJS.Timeout | null = null
function saveSession(userData: string, state: TabsState): void {
  if (headless) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const user = state.tabs.filter((t) => t.owner === 'user' && t.profile === DEFAULT_PROFILE && /^https?:/.test(t.url))
    const saved: SavedSession = {
      tabs: user.map((t) => ({ url: t.url, title: t.title })),
      active: Math.max(0, user.findIndex((t) => t.id === state.activeId)),
    }
    try {
      writeFileSync(join(userData, 'session.json'), JSON.stringify(saved))
    } catch {}
  }, 800)
}

function loadSession(userData: string): SavedSession | null {
  const file = join(userData, 'session.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SavedSession
  } catch {
    return null
  }
}
