import { EventEmitter } from 'node:events'
import { Menu, WebContentsView, clipboard, session as electronSession, type NavigationEntry, type Session, type WebContents } from 'electron'
import { DEFAULT_PROFILE, type CreateTabOptions, type TabInfo, type TabsState } from '../shared/protocol'
import type { Shell } from './shell'
import { resolveInput } from './url'

interface Tab {
  info: TabInfo
  /** null while the tab is asleep (restored but not yet loaded, or put to sleep to save memory). */
  view: WebContentsView | null
  saved?: { entries: NavigationEntry[]; index: number }
  debuggerAttached: boolean
  lastActive: number
  /** Set while the page is drawn scaled down in a task's floating window; identifies the scale in force. */
  zoom?: number
}

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])

/**
 * Owns every tab. One WebContentsView per tab; only the active one is visible.
 * Emits 'changed' whenever the tab list or any tab's state changes, 'cdp' for
 * DevTools Protocol events, and 'visit' for history.
 */
export class TabManager extends EventEmitter {
  private tabs = new Map<string, Tab>()
  private order: string[] = []
  private seq = 0
  private preparedSessions = new WeakSet<Session>()
  activeId: string | null = null
  /** A small picture of each tab as it last looked, for the overview. */
  readonly thumbs = new Map<string, string>()

  constructor(
    private shell: Shell,
    private hooks: { prepareSession?: (ses: Session, profile: string) => void } = {},
  ) {
    super()
  }

  // ---- queries ---------------------------------------------------------------

  state(): TabsState {
    return { tabs: this.order.map((id) => this.tabs.get(id)!.info), activeId: this.activeId }
  }

  get(id: string): Tab | undefined {
    return this.tabs.get(id)
  }

  info(id: string): TabInfo | undefined {
    return this.tabs.get(id)?.info
  }

  active(): Tab | undefined {
    return this.activeId ? this.tabs.get(this.activeId) : undefined
  }

  webContents(id: string): WebContents {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`no tab ${id}`)
    return this.wake(tab).webContents
  }

  // ---- lifecycle -------------------------------------------------------------

  create(opts: CreateTabOptions = {}): TabInfo {
    const id = `t${++this.seq}`
    const owner = opts.owner ?? 'user'
    const profile = opts.profile ?? DEFAULT_PROFILE
    const url = opts.url ? resolveInput(opts.url) : 'about:blank'
    const tab: Tab = {
      info: { id, title: 'New Tab', url, loading: false, canGoBack: false, canGoForward: false, owner, profile, session: opts.session },
      view: null,
      debuggerAttached: false,
      lastActive: Date.now(),
    }
    this.tabs.set(id, tab)
    const openerIndex = opts.opener ? this.order.indexOf(opts.opener) : -1
    if (openerIndex >= 0) this.order.splice(openerIndex + 1, 0, id)
    else this.order.push(id)

    this.wake(tab)
    if (opts.activate ?? owner === 'user') this.activate(id)
    else if (!this.activeId) {
      this.activeId = id
      this.relayout()
    }
    this.changed()
    return tab.info
  }

  /** Restore a tab without loading it; it loads the first time it is activated. */
  createAsleep(url: string, title: string): TabInfo {
    const id = `t${++this.seq}`
    const tab: Tab = {
      info: { id, title: title || url, url, loading: false, canGoBack: false, canGoForward: false, owner: 'user', profile: DEFAULT_PROFILE, asleep: true },
      view: null,
      debuggerAttached: false,
      lastActive: 0,
    }
    this.tabs.set(id, tab)
    this.order.push(id)
    this.changed()
    return tab.info
  }

  close(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const index = this.order.indexOf(id)
    this.order.splice(index, 1)
    this.tabs.delete(id)
    this.thumbs.delete(id)
    this.destroyView(tab)
    if (this.activeId === id) {
      this.activeId = null
      // Prefer a neighbouring tab of the same kind.
      const next = this.order[index] ?? this.order[index - 1]
      if (next) this.activate(next)
    }
    this.emit('closed', id)
    this.changed()
  }

  /** The user chose a tab: show that page, leaving any task view. */
  activate(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.activeId = id
    tab.lastActive = Date.now()
    if (this.shell.layout.mode !== 'browse') this.shell.setLayout({ mode: 'browse', peek: null })
    else this.relayout()
    // A tab with nothing in it yet shows the start page, which the window draws; the keyboard goes there.
    if (!this.shell.overlayOpen) (this.isBlank(id) ? this.shell.ui : tab.view)?.webContents.focus()
    this.changed()
  }

  /** A tab that has not been taken anywhere yet. */
  isBlank(id: string | null): boolean {
    const url = id ? this.tabs.get(id)?.info.url : undefined
    return !!id && this.tabs.has(id) && (!url || url === 'about:blank')
  }

  /** Free a background tab's renderer, keeping its history so it can be restored on demand. */
  sleep(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab || !tab.view || id === this.activeId || this.shell.layout.peeks.includes(id) || tab.info.owner === 'agent') return
    const nav = tab.view.webContents.navigationHistory
    tab.saved = { entries: nav.getAllEntries(), index: nav.getActiveIndex() }
    this.destroyView(tab)
    tab.info.asleep = true
    tab.info.loading = false
    this.changed()
  }

  /** Put user tabs that have been in the background for a while to sleep. */
  sleepIdle(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs
    for (const tab of this.tabs.values()) {
      if (tab.view && tab.info.owner === 'user' && tab.info.id !== this.activeId && tab.lastActive < cutoff) {
        if (!tab.view.webContents.isCurrentlyAudible()) this.sleep(tab.info.id)
      }
    }
  }

  /**
   * Put the right tab on screen. In a page view that is the user's active tab,
   * filling the card. In a task view it is the tab that task is working on,
   * shown small and at half scale in the floating window.
   */
  relayout(): void {
    const mode = this.shell.layout.mode
    const task = mode === 'chat'
    // The overview shows pictures of every tab, so no live page is on screen.
    const showId = task ? this.shell.layout.peek : mode === 'overview' || mode === 'tasks' ? null : this.activeId
    // A task view shows every page the task is working in, live: one large, the rest small.
    const tiles = task ? this.shell.tiles().filter((t) => this.tabs.has(t.id)) : []
    const live = new Set(tiles.map((t) => t.id))
    for (const tab of this.tabs.values()) {
      if (!tab.view || tab.info.id === showId || live.has(tab.info.id)) continue
      if (tab.view.getVisible()) tab.view.setVisible(false)
      this.scale(tab, 1, null)
    }
    if (task) {
      for (const tile of tiles) {
        const tab = this.tabs.get(tile.id)!
        const view = this.wake(tab)
        const bounds = this.shell.tileView(tile)
        view.setBounds(bounds)
        // Each is the real page at laptop width, scaled to fit, so its layout never changes.
        this.scale(tab, bounds.width / this.shell.pageWidth(), bounds)
        view.setVisible(true)
      }
      this.shell.raiseOverlay()
      return
    }
    const tab = showId ? this.tabs.get(showId) : undefined
    if (!tab) return
    const view = this.wake(tab)
    // An empty tab has no page to show; the window draws its start page in the card instead.
    if (!task && this.isBlank(tab.info.id)) {
      if (view.getVisible()) view.setVisible(false)
      return
    }
    const bounds = this.shell.cardBounds()
    view.setBounds(bounds)
    // The floating window is the real page at laptop width, scaled to fit, so its layout never changes.
    this.scale(tab, task ? bounds.width / this.shell.pageWidth() : 1, bounds)
    view.setVisible(true)
    this.shell.raiseOverlay()
  }

  /**
   * Draw a tab's page smaller than life without changing its layout: the page
   * keeps a laptop-sized viewport and only the picture of it is scaled. This is
   * done per tab through the DevTools Protocol, because Chromium's own zoom is
   * shared by every tab on the same site.
   */
  private scale(tab: Tab, factor: number, bounds: Electron.Rectangle | null): void {
    if (!tab.view) return
    const wc = tab.view.webContents
    if (factor >= 0.999 || !bounds) {
      if (tab.zoom === undefined) return
      tab.zoom = undefined
      if (wc.debugger.isAttached()) void wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {})
      return
    }
    const key = Math.round(factor * 1000) + bounds.width * 7 + bounds.height * 13
    if (tab.zoom === key) return
    tab.zoom = key
    try {
      if (!wc.debugger.isAttached()) this.attachDebugger(tab.info.id)
      void wc.debugger
        .sendCommand('Emulation.setDeviceMetricsOverride', {
          width: Math.round(bounds.width / factor),
          height: Math.round(bounds.height / factor),
          deviceScaleFactor: 0,
          mobile: false,
          scale: factor,
        })
        .catch(() => {})
    } catch {
      // Another debugger (the page's own DevTools) holds the tab; it is shown unscaled.
    }
  }

  // ---- navigation ------------------------------------------------------------

  navigate(id: string, input: string): void {
    const wc = this.webContents(id)
    const tab = this.tabs.get(id)!
    const url = resolveInput(input)
    if (this.isBlank(id) && url !== 'about:blank') {
      // Leaving the start page: the page takes the card at once, while it loads.
      tab.info.url = url
      this.relayout()
      if (id === this.activeId && !this.shell.overlayOpen) wc.focus()
      this.changed()
    }
    void wc.loadURL(url).catch(() => {})
  }

  back(id: string): void {
    const nav = this.webContents(id).navigationHistory
    if (nav.canGoBack()) nav.goBack()
  }

  forward(id: string): void {
    const nav = this.webContents(id).navigationHistory
    if (nav.canGoForward()) nav.goForward()
  }

  reload(id: string): void {
    this.webContents(id).reload()
  }

  stop(id: string): void {
    this.webContents(id).stop()
  }

  setBusy(id: string, busy: boolean): void {
    const tab = this.tabs.get(id)
    if (!tab || tab.info.busy === busy) return
    tab.info.busy = busy
    this.changed()
  }

  /** Keep a small picture of a tab, taken while it is on screen at full size. */
  async snapshot(id: string | null): Promise<void> {
    const tab = id ? this.tabs.get(id) : undefined
    if (!tab?.view || !tab.view.getVisible() || tab.zoom !== undefined) return
    try {
      const image = await tab.view.webContents.capturePage()
      if (image.isEmpty()) return
      const jpeg = image.resize({ width: 640, quality: 'good' }).toJPEG(72)
      this.thumbs.set(tab.info.id, `data:image/jpeg;base64,${jpeg.toString('base64')}`)
      // A picture of each of your own pages is also kept by address, for the new tab page.
      if (tab.info.owner === 'user' && tab.info.profile === DEFAULT_PROFILE && /^https?:/.test(tab.info.url) && !this.shell.layout.frame) this.emit('thumb', { url: tab.info.url, jpeg })
    } catch {}
  }

  // ---- DevTools Protocol -------------------------------------------------------

  attachDebugger(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`no tab ${id}`)
    const wc = this.wake(tab).webContents
    if (tab.debuggerAttached && wc.debugger.isAttached()) return
    wc.debugger.attach('1.3')
    tab.debuggerAttached = true
  }

  async cdp(id: string, method: string, params?: object, sessionId?: string): Promise<unknown> {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`no tab ${id}`)
    const wc = this.wake(tab).webContents
    if (!wc.debugger.isAttached()) this.attachDebugger(id)
    return wc.debugger.sendCommand(method, params, sessionId)
  }

  // ---- internals -------------------------------------------------------------

  private sessionFor(profile: string): Session {
    // Agent profiles have no `persist:` prefix, so their cookies and storage live in memory only.
    const partition = profile === DEFAULT_PROFILE ? 'persist:brewse-default' : `brewse-agent-${profile}`
    const ses = electronSession.fromPartition(partition)
    if (!this.preparedSessions.has(ses)) {
      this.preparedSessions.add(ses)
      // Present as the Chromium we are; the Electron/app tokens only cause sites to misdetect us.
      ses.setUserAgent(ses.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ brewse\/\S+/i, ''))
      const isAgent = profile !== DEFAULT_PROFILE
      ses.setPermissionRequestHandler((_wc, permission, callback) => callback(!isAgent && ALLOWED_PERMISSIONS.has(permission)))
      ses.setPermissionCheckHandler((_wc, permission) => !isAgent && ALLOWED_PERMISSIONS.has(permission))
      this.hooks.prepareSession?.(ses, profile)
    }
    return ses
  }

  private wake(tab: Tab): WebContentsView {
    if (tab.view) return tab.view
    const { info } = tab
    const view = new WebContentsView({
      webPreferences: {
        session: this.sessionFor(info.profile),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Agent tabs must keep running at full speed while in the background.
        backgroundThrottling: info.owner !== 'agent',
      },
    })
    tab.view = view
    tab.debuggerAttached = false
    info.asleep = false
    view.setBorderRadius(this.shell.cardRadius)
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    view.setBounds(this.shell.cardBounds())
    this.shell.addTabView(view)
    this.wire(tab, view.webContents)

    if (tab.saved && tab.saved.entries.length) {
      void view.webContents.navigationHistory.restore(tab.saved).catch(() => view.webContents.loadURL(info.url).catch(() => {}))
      tab.saved = undefined
    } else {
      // Always load something, even a blank page: without a document the tab has no
      // renderer, and DevTools Protocol commands sent to it would wait forever.
      void view.webContents.loadURL(info.url || 'about:blank').catch(() => {})
    }
    return view
  }

  private destroyView(tab: Tab): void {
    const view = tab.view
    if (!view) return
    tab.view = null
    tab.debuggerAttached = false
    tab.zoom = undefined
    this.shell.removeTabView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private wire(tab: Tab, wc: WebContents): void {
    const { info } = tab
    const sync = () => {
      if (wc.isDestroyed()) return
      const wasBlank = this.isBlank(info.id)
      info.url = wc.getURL() || info.url
      if (wasBlank !== this.isBlank(info.id) && info.id === this.activeId) this.relayout()
      info.title = this.isBlank(info.id) ? 'New tab' : wc.getTitle() || info.url
      info.loading = wc.isLoading()
      info.canGoBack = wc.navigationHistory.canGoBack()
      info.canGoForward = wc.navigationHistory.canGoForward()
      this.changed()
    }
    wc.on('did-start-loading', sync)
    wc.on('did-stop-loading', sync)
    wc.on('did-stop-loading', () => setTimeout(() => void this.snapshot(info.id), 900))
    wc.on('page-title-updated', sync)
    wc.on('did-navigate-in-page', sync)
    wc.on('did-navigate', (_e, url) => {
      info.favicon = undefined
      sync()
      if (info.owner === 'user') this.emit('visit', { url, title: wc.getTitle() })
    })
    wc.on('page-title-updated', (_e, title) => {
      if (info.owner === 'user') this.emit('title', { url: wc.getURL(), title })
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      info.favicon = favicons[0]
      this.changed()
    })
    wc.on('render-process-gone', () => {
      info.loading = false
      this.changed()
    })
    wc.setWindowOpenHandler(({ url, disposition }) => {
      // Pop-ups become tabs with the same owner and profile, so an agent's pop-up stays in the agent's sandbox.
      const created = this.create({
        url,
        owner: info.owner,
        profile: info.profile,
        session: info.session,
        opener: info.id,
        activate: info.owner === 'user' && disposition !== 'background-tab',
      })
      this.emit('opened', { id: created.id, opener: info.id, url })
      return { action: 'deny' }
    })
    wc.debugger.on('message', (_e, method, params, sessionId) => {
      this.emit('cdp', { id: info.id, method, params, sessionId })
    })
    wc.debugger.on('detach', (_e, reason) => {
      tab.debuggerAttached = false
      this.emit('cdp-detached', { id: info.id, reason })
    })
    wc.on('context-menu', (_e, p) => {
      const items: Electron.MenuItemConstructorOptions[] = []
      if (p.linkURL) {
        items.push(
          { label: 'Open Link in New Tab', click: () => this.create({ url: p.linkURL, opener: info.id, activate: false, owner: info.owner, profile: info.profile }) },
          { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
          { type: 'separator' },
        )
      }
      if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' })
      else if (p.selectionText) items.push({ role: 'copy' }, { type: 'separator' })
      items.push(
        { label: 'Back', enabled: info.canGoBack, click: () => this.back(info.id) },
        { label: 'Forward', enabled: info.canGoForward, click: () => this.forward(info.id) },
        { label: 'Reload', click: () => this.reload(info.id) },
        { type: 'separator' },
        { label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) },
      )
      Menu.buildFromTemplate(items).popup()
    })
  }

  private pending = false
  private changed(): void {
    if (this.pending) return
    this.pending = true
    setImmediate(() => {
      this.pending = false
      this.emit('changed', this.state())
    })
  }
}
