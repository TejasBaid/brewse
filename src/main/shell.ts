import { join } from 'node:path'
import { BaseWindow, WebContentsView, screen, type Rectangle, type View } from 'electron'
import { MAX_TILES, WORK_BORDER, type Layout, type OverlayMode, type Tile } from '../shared/protocol'

const INSET = 8
/** How much of the bottom of the page counts as its bottom edge, for summoning the dock. */
const EDGE = 12
/** Height of the toolbar at the top of the page card. Must match `--toolbar` in the stylesheet. */
const TOOLBAR = 44
const INSET_MIN = 280
const INSET_MAX = 420
const INSET_RATIO = 0.68
const INSET_MARGIN = 14
const INSET_HEADER = 28
const INSET_TOP = 6
/** The small live pages under the large one: their header, the gap between them, and their shape. */
const SMALL_HEADER = 22
const TILE_GAP = 10
const SMALL_RATIO = 0.62
const MIN_SIDEBAR = 200
const MAX_SIDEBAR = 420

/**
 * The window and its fixed layers, bottom to top:
 *   ui      — sidebar, agent panel and the card frame, drawn over native vibrancy
 *   tabs    — one WebContentsView per tab, positioned over the card frame
 *   overlay — command bar; transparent and hidden unless open
 * The main process owns all geometry so resizing never waits on the UI.
 */
export class Shell {
  readonly win: BaseWindow
  readonly ui: WebContentsView
  readonly overlay: WebContentsView
  readonly cardRadius = 10
  layout: Layout = { sidebar: 248, panel: 0, sidebarVisible: false, mode: 'browse', peek: null, peeks: [], tiles: [], frame: false }
  overlayOpen = false
  /** How much of the card the dock currently covers, measured up from its bottom edge. Null when it is away. */
  private dock: { px?: number; fraction?: number } | null = null
  onDockHidden: () => void = () => {}
  onDockSized: (spec: { px?: number; fraction?: number }) => void = () => {}
  onLayout: () => void = () => {}

  constructor(private opts: { headless: boolean; outDir: string; quiet?: boolean }) {
    this.win = new BaseWindow({
      width: 1440,
      height: 920,
      minWidth: 820,
      minHeight: 520,
      show: false,
      titleBarStyle: 'hiddenInset',
      vibrancy: 'under-window',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
    })

    // macOS greys out or hides its own window buttons depending on focus and hover.
    // The interface draws its own instead, so they are always there and always coloured.
    this.win.setWindowButtonVisibility(false)

    const webPreferences = {
      preload: join(opts.outDir, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      transparent: true,
    }
    this.ui = new WebContentsView({ webPreferences })
    // The layer above the page is hidden whenever it has nothing to show, and a hidden view's timers
    // are slowed to about one a second. It has to answer the pointer and the keyboard at once, so it is
    // never slowed; it does nothing while hidden, so this costs nothing.
    this.overlay = new WebContentsView({ webPreferences: { ...webPreferences, backgroundThrottling: false } })
    for (const view of [this.ui, this.overlay]) view.setBackgroundColor('#00000000')
    this.win.contentView.addChildView(this.ui)
    this.win.contentView.addChildView(this.overlay)
    this.overlay.setVisible(false)

    this.load(this.ui, 'chrome')
    this.load(this.overlay, 'overlay')

    this.win.on('resize', () => this.relayout())
    if (!opts.headless) this.watchPointer()
    this.relayout()
    // The window appears at once, as native material; the interface paints into it a moment later.
    // A capture run (`--shot`) must not take the keyboard or the pointer from whoever is at the machine.
    if (opts.quiet) {
      this.win.setFocusable(false)
      this.win.setIgnoreMouseEvents(true)
      this.win.showInactive()
    } else if (!opts.headless) this.win.show()
    if (process.env['BREWSE_TIMING']) {
      const at = () => Math.round(process.uptime() * 1000)
      console.log(`[brewse] window shown ${at()}ms after process start`)
      this.ui.webContents.once('did-finish-load', () => console.log(`[brewse] interface painted ${at()}ms after process start`))
    }
  }

  private load(view: WebContentsView, route: string): void {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev) void view.webContents.loadURL(`${dev}#/${route}`)
    else void view.webContents.loadFile(join(this.opts.outDir, '../renderer/index.html'), { hash: `/${route}` })
  }

  /** How wide a page is when it fills the card. The floating window shows the page laid out at this width, scaled down. */
  pageWidth(): number {
    const [w] = this.win.getContentSize()
    const left = this.layout.sidebarVisible ? this.layout.sidebar : INSET
    return Math.max(1100, w - left - INSET)
  }

  /** Where the active tab's page is drawn: inside the card, below its toolbar. */
  cardBounds(): Rectangle {
    const [w, h] = this.win.getContentSize()
    const { sidebar, panel, sidebarVisible } = this.layout
    const left = sidebarVisible ? sidebar : INSET
    const right = panel > 0 ? panel : INSET
    const cardWidth = Math.max(200, w - left - right)
    if (this.layout.mode === 'chat') {
      // A task view: the page is the large live tile at the top right of the card.
      const first = this.tiles()[0]
      if (first) return this.tileView(first)
    }
    const top = INSET + TOOLBAR
    const full = { x: left, y: top, width: cardWidth, height: Math.max(200, h - top - INSET) }
    // A page that is being worked on is drawn a little smaller, so the border around it shows.
    if (this.layout.frame && this.layout.mode === 'browse') return { x: full.x + WORK_BORDER, y: full.y + WORK_BORDER, width: full.width - 2 * WORK_BORDER, height: full.height - 2 * WORK_BORDER }
    return full
  }

  /**
   * Where a task's live pages go: a column at the top right of the card. The
   * first is large; the others sit beneath it two abreast. The interface draws
   * a frame for each from these same numbers.
   */
  tiles(): Tile[] {
    const ids = this.layout.peeks.slice(0, MAX_TILES)
    if (!ids.length) return []
    const [w] = this.win.getContentSize()
    const left = this.layout.sidebarVisible ? this.layout.sidebar : INSET
    const cardWidth = Math.max(200, w - left - INSET)
    const width = Math.round(Math.min(INSET_MAX, Math.max(INSET_MIN, cardWidth * 0.3)))
    const x = left + cardWidth - width - INSET_MARGIN
    const y = INSET + TOOLBAR + INSET_TOP
    const out: Tile[] = [{ id: ids[0], x, y, width, height: Math.round(width * INSET_RATIO), header: INSET_HEADER, primary: true }]
    const small = Math.floor((width - TILE_GAP) / 2)
    const smallHeight = SMALL_HEADER + Math.round(small * SMALL_RATIO)
    ids.slice(1).forEach((id, i) => {
      out.push({ id, x: x + (i % 2) * (small + TILE_GAP), y: y + out[0].height + TILE_GAP + Math.floor(i / 2) * (smallHeight + TILE_GAP), width: small, height: smallHeight, header: SMALL_HEADER, primary: false })
    })
    return out
  }

  /** The part of a tile the page itself is drawn in: under its header, inside its border. */
  tileView(t: Tile): Rectangle {
    return { x: t.x + WORK_BORDER, y: t.y + t.header, width: t.width - 2 * WORK_BORDER, height: t.height - t.header - WORK_BORDER }
  }

  /** Close, minimise or toggle full screen, for the window buttons the interface draws itself. */
  windowAction(action: 'close' | 'minimize' | 'zoom'): void {
    if (action === 'close') this.win.close()
    else if (action === 'minimize') this.win.minimize()
    else this.win.setFullScreen(!this.win.isFullScreen())
  }

  relayout(): void {
    const [w, h] = this.win.getContentSize()
    const full = { x: 0, y: 0, width: w, height: h }
    this.ui.setBounds(full)
    if (this.overlayOpen || !this.dock) this.overlay.setBounds(full)
    else this.applyDock()
    // The live pages of a task view move with the window; the interface draws their frames from the same numbers.
    if (this.layout.mode === 'chat') {
      this.layout.tiles = this.tiles()
      this.send('layout', this.layout)
    }
    this.onLayout()
  }

  setLayout(patch: Partial<Layout>): Layout {
    const next = { ...this.layout, ...patch }
    next.sidebar = Math.round(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, next.sidebar)))
    next.panel = Math.round(Math.max(0, next.panel))
    // There is no sidebar: tabs and tasks are words in the toolbar.
    next.sidebarVisible = false
    // The live pages of a task view: `peeks` lists them, and `peek` is the large one.
    if (patch.peeks) next.peek = patch.peeks[0] ?? null
    else if ('peek' in patch) next.peeks = patch.peek ? [patch.peek, ...next.peeks.filter((id) => id !== patch.peek)] : []
    if (next.mode !== 'chat') {
      next.peek = null
      next.peeks = []
    }
    if (next.mode !== 'browse') next.frame = false
    this.layout = next
    this.layout.tiles = this.layout.mode === 'chat' ? this.tiles() : []
    this.onLayout()
    this.send('layout', this.layout)
    return this.layout
  }

  addTabView(view: View): void {
    // Insert below the overlay so the command bar always sits on top.
    this.win.contentView.addChildView(view, 1)
  }

  removeTabView(view: View): void {
    this.win.contentView.removeChildView(view)
  }

  raiseOverlay(): void {
    this.win.contentView.addChildView(this.overlay)
  }

  /** The whole card, toolbar included. */
  private cardFrame(): Rectangle {
    const [w, h] = this.win.getContentSize()
    const { sidebar, panel, sidebarVisible } = this.layout
    const left = sidebarVisible ? sidebar : INSET
    const right = panel > 0 ? panel : INSET
    return { x: left, y: INSET, width: Math.max(200, w - left - right), height: Math.max(200, h - 2 * INSET) }
  }

  /**
   * Tell the dock when the pointer rests on the bottom edge of the page, or is
   * over the dock itself. This is measured here, from the pointer's position,
   * because the page and the dock are separate layers: neither sees the pointer
   * cross into the other, and a layer that changes size under a still pointer
   * reports it coming and going. The dock decides what to do with it.
   */
  private watchPointer(): void {
    let near = false
    let resizedAt = 0
    this.win.on('resize', () => (resizedAt = Date.now()))
    const timer = setInterval(() => {
      let now = false
      // Not while the window is being resized by its bottom edge, and not behind the command bar or in a task.
      if (this.win.isFocused() && this.win.isVisible() && !this.overlayOpen && this.layout.mode === 'browse' && Date.now() - resizedAt > 700) {
        const point = screen.getCursorScreenPoint()
        const content = this.win.getContentBounds()
        const card = this.cardFrame()
        const x = point.x - content.x
        const y = point.y - content.y
        const edge = card.y + card.height - EDGE
        const top = this.dock ? Math.min(this.overlay.getBounds().y, edge) : edge
        now = x >= card.x && x <= card.x + card.width && y >= top && y <= content.height + 4
      }
      if (now === near) return
      near = now
      if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.send('dock:pointer', { near })
    }, 50)
    this.win.on('closed', () => clearInterval(timer))
  }

  private applyDock(): void {
    if (!this.dock || this.overlayOpen) return
    const card = this.cardFrame()
    const height = Math.min(card.height, Math.round(this.dock.fraction ? card.height * this.dock.fraction : (this.dock.px ?? 0)))
    this.overlay.setBorderRadius(this.cardRadius)
    this.overlay.setBounds({ x: card.x, y: card.y + card.height - height, width: card.width, height })
    this.raiseOverlay()
    this.overlay.setVisible(true)
  }

  /**
   * Size the dock: the prompt, status line and result sheet that rise from the
   * bottom of the page. The layer only covers what it draws, so the rest of the
   * page stays clickable. A height of zero puts it away.
   */
  sizeDock(spec: { px?: number; fraction?: number; focus?: boolean }): void {
    if (!spec.fraction && !(spec.px && spec.px > 0)) {
      const wasShown = this.dock !== null
      this.dock = null
      if (!this.overlayOpen) this.overlay.setVisible(false)
      if (wasShown) this.onDockHidden()
      return
    }
    this.dock = { px: spec.px, fraction: spec.fraction }
    this.applyDock()
    this.onDockSized(this.dock)
    if (spec.focus && !this.overlayOpen) this.overlay.webContents.focus()
  }

  /** Development screenshots: where a window rectangle falls inside the dock layer. */
  dockOffset(rect: Rectangle): Rectangle {
    const b = this.overlay.getBounds()
    return { ...rect, x: rect.x - b.x, y: rect.y - b.y }
  }

  showOverlay(mode: OverlayMode, payload: object = {}): void {
    this.overlayOpen = true
    this.overlay.setBorderRadius(0)
    const [w, h] = this.win.getContentSize()
    this.overlay.setBounds({ x: 0, y: 0, width: w, height: h })
    this.raiseOverlay()
    this.overlay.setVisible(true)
    this.overlay.webContents.focus()
    this.overlay.webContents.send('overlay:show', { mode, ...payload })
  }

  hideOverlay(): void {
    if (!this.overlayOpen) return
    this.overlayOpen = false
    this.overlay.webContents.send('overlay:hide', {})
    // The dock may have been waiting underneath the command bar; give the layer back to it.
    if (this.dock) this.applyDock()
    else this.overlay.setVisible(false)
  }

  /** Send to both UI layers. */
  send(channel: string, data: unknown): void {
    for (const view of [this.ui, this.overlay]) {
      if (!view.webContents.isDestroyed()) view.webContents.send(channel, data)
    }
  }
}
