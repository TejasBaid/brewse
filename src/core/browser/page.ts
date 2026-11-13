import agentSource from './inject/page-agent.js?raw'
import { parseKey } from './keys'
import type { Action, Expectation, Receipt, Snapshot } from './types'

const WORLD = 'brewse'
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Cdp = (method: string, params?: object, sessionId?: string) => Promise<any>

interface Resolved {
  ok: boolean
  error?: string
  x: number
  y: number
  tag: string
  type?: string
  role: string
  name: string
  disabled: boolean
  editable: boolean
  href?: string
  covered?: string
  cover?: { ids: number[]; text: string }
}

export interface ExpectResult {
  ok: boolean
  why: string
}

const VALUE_INPUTS = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'])
const IGNORED_REQUESTS = new Set(['EventSource', 'WebSocket', 'Ping', 'Media', 'CSPViolationReport', 'Prefetch'])

/**
 * Drives one tab over the DevTools Protocol. All page-side logic lives in the
 * injected page agent; this class sends it commands, dispatches trusted input,
 * and decides when the page has settled.
 */
export class Page {
  private ctx: number | null = null
  private attached = false
  private attaching: Promise<void> | null = null
  private inflight = new Map<string, number>()
  private pendingNav: string | null = null
  private mainFrame: string | null = null
  navCount = 0
  /** Messages of JavaScript dialogs that were accepted automatically since the last report. */
  dialogLog: string[] = []
  pendingDialog: { type: string; message: string } | null = null
  /** Tabs opened by this page since the last report. */
  openedTabs: string[] = []
  last: Snapshot | null = null

  constructor(
    readonly tabId: string,
    private send: Cdp,
    private nav: { back(): Promise<void>; forward(): Promise<void>; reload(): Promise<void>; capture(): Promise<string> },
  ) {}

  // ---- connection --------------------------------------------------------------

  attach(): Promise<void> {
    if (this.attached) return Promise.resolve()
    return (this.attaching ??= (async () => {
      await this.send('Page.enable')
      await this.send('Network.enable')
      await this.send('Page.addScriptToEvaluateOnNewDocument', { source: agentSource, worldName: WORLD })
      // Lets key events and focus work in tabs that are not in front.
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      const tree = await this.send('Page.getFrameTree')
      this.mainFrame = tree.frameTree.frame.id
      this.attached = true
      this.attaching = null
    })())
  }

  onDetached(): void {
    this.attached = false
    this.attaching = null
    this.ctx = null
  }

  onEvent(method: string, params: any): void {
    switch (method) {
      case 'Network.requestWillBeSent':
        if (IGNORED_REQUESTS.has(params.type)) return
        this.inflight.set(params.requestId, Date.now())
        if (params.type === 'Document' && params.frameId === this.mainFrame) this.pendingNav = params.requestId
        return
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
        this.inflight.delete(params.requestId)
        if (this.pendingNav === params.requestId && method === 'Network.loadingFailed') this.pendingNav = null
        return
      case 'Page.frameNavigated':
        if (!params.frame.parentId) {
          this.mainFrame = params.frame.id
          this.ctx = null
          this.navCount++
          this.pendingNav = null
          this.inflight.clear()
        }
        return
      case 'Page.javascriptDialogOpening':
        if (params.type === 'alert' || params.type === 'beforeunload') {
          this.dialogLog.push(`${params.type}: ${String(params.message).slice(0, 200)}`)
          void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
        } else {
          this.pendingDialog = { type: params.type, message: String(params.message).slice(0, 300) }
        }
        return
      case 'Page.javascriptDialogClosed':
        this.pendingDialog = null
        return
    }
  }

  // ---- page agent calls --------------------------------------------------------

  private async world(): Promise<number> {
    if (this.ctx != null) return this.ctx
    const tree = await this.send('Page.getFrameTree')
    this.mainFrame = tree.frameTree.frame.id
    const { executionContextId } = await this.send('Page.createIsolatedWorld', { frameId: this.mainFrame, worldName: WORLD })
    return (this.ctx = executionContextId)
  }

  /** Call a page-agent function. Retries across navigations, which destroy the execution context. */
  async call<T = any>(fn: string, ...args: unknown[]): Promise<T> {
    await this.attach()
    const expression = `__brewse.${fn}(${args.map((a) => JSON.stringify(a ?? null)).join(',')})`
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const contextId = await this.world()
        const r = await this.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true })
        if (r.exceptionDetails) {
          const message: string = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'page error'
          if (/__brewse is not defined/.test(message)) {
            await this.send('Runtime.evaluate', { expression: agentSource, contextId })
            continue
          }
          throw new Error(message.split('\n')[0])
        }
        return r.result.value as T
      } catch (e) {
        lastError = e as Error
        if (/context|navigated|closed|target/i.test(lastError.message) && !/page error/.test(lastError.message)) {
          this.ctx = null
          await sleep(60)
          continue
        }
        throw lastError
      }
    }
    throw lastError ?? new Error('page not reachable')
  }

  async snapshot(opts: { text?: boolean | number; viewportOnly?: boolean } = {}): Promise<Snapshot> {
    return (this.last = await this.call<Snapshot>('snapshot', opts))
  }

  // ---- settling ----------------------------------------------------------------

  /**
   * Wait for the page to finish reacting, using signals rather than fixed sleeps:
   * no document navigation in flight, the DOM quiet for 80ms, and no network
   * request younger than 1.5s (older ones are long-polls or analytics).
   */
  async settle(kind: 'action' | 'nav' = 'action'): Promise<void> {
    const start = Date.now()
    let cap = kind === 'nav' ? 5000 : 1000
    const navAtStart = this.navCount
    if (kind === 'action') await sleep(25)
    for (;;) {
      const elapsed = Date.now() - start
      if (this.pendingNav) {
        // A navigation is on its way: allow it time to commit before judging the page.
        cap = Math.max(cap, 10_000)
        if (elapsed > cap) break
        await sleep(40)
        continue
      }
      if (this.navCount !== navAtStart) cap = Math.max(cap, Math.min(elapsed + 4000, 12_000))
      if (elapsed >= cap) break
      let q: { quiet: boolean; ready: string }
      try {
        q = await this.call('waitQuiet', 80, Math.max(50, Math.min(500, cap - elapsed)))
      } catch {
        this.ctx = null
        await sleep(50)
        continue
      }
      if (q.ready === 'loading' || !q.quiet) continue
      const now = Date.now()
      let young = false
      for (const t of this.inflight.values()) {
        if (now - t < 1500) {
          young = true
          break
        }
      }
      if (!young) break
      await sleep(50)
    }
  }

  async expect(list: Expectation[], timeoutMs = 2500): Promise<ExpectResult[]> {
    const local = list.filter((e) => !('jev' in e))
    if (!local.length) return []
    const start = Date.now()
    for (;;) {
      const results = await this.call<ExpectResult[]>('expect', local)
      if (results.every((r) => r.ok) || Date.now() - start >= timeoutMs) return results
      await sleep(150)
    }
  }

  // ---- input -------------------------------------------------------------------

  private async mouse(type: string, x: number, y: number, extra: object = {}): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra })
  }

  private async clickAt(x: number, y: number): Promise<void> {
    await this.mouse('mouseMoved', x, y)
    await this.mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
    await this.mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 })
  }

  private async key(spec: string): Promise<boolean> {
    const k = parseKey(spec)
    if (!k) return false
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers }
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, text: k.text, unmodifiedText: k.text })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    return true
  }

  private async resolve(id: number): Promise<Resolved | { ok: false; error: string }> {
    const r = await this.call<Resolved>('resolve', id, { scroll: true })
    if (!r.ok) {
      const why = r.error === 'gone' ? 'no longer exists (the page changed); take a new browser_state' : r.error === 'hidden' ? 'is not visible' : 'is outside the viewport and could not be scrolled into view'
      return { ok: false, error: `[${id}] ${why}` }
    }
    return r
  }

  /** Perform one action. Never retries input that may already have reached the page. */
  async perform(a: Action): Promise<Receipt> {
    const fail = (line: string, delivered = false): Receipt => ({ ok: false, line, delivered })
    const label = (r: Resolved) => `${r.role}${r.name ? ` "${r.name}"` : ''}`
    try {
      switch (a.op) {
        case 'goto': {
          if (!a.url) return fail('goto needs a url')
          const before = this.navCount
          const r = await this.send('Page.navigate', { url: a.url })
          if (r.errorText && r.errorText !== 'net::ERR_ABORTED') return fail(`could not load ${a.url}: ${r.errorText}`)
          if (r.loaderId) {
            const start = Date.now()
            while (this.navCount === before && Date.now() - start < 10_000) await sleep(30)
          }
          await this.settle('nav')
          return { ok: true, line: `opened ${a.url}`, delivered: true }
        }
        case 'back':
        case 'forward':
        case 'reload': {
          const before = this.navCount
          await this.nav[a.op]()
          const start = Date.now()
          while (this.navCount === before && Date.now() - start < 3000) await sleep(30)
          await this.settle('nav')
          return { ok: true, line: a.op === 'reload' ? 'reloaded' : `went ${a.op}`, delivered: true }
        }
        case 'click': {
          if (a.id == null) {
            if (a.x == null || a.y == null) return fail('click needs an id, a target description, or x and y')
            await this.clickAt(a.x, a.y)
            await this.settle()
            return { ok: true, line: `clicked at ${a.x},${a.y}`, delivered: true }
          }
          const r = await this.resolve(a.id)
          if (!r.ok) return fail(r.error!)
          const el = r as Resolved
          if (el.disabled) return fail(`[${a.id}] ${label(el)} is disabled`)
          if (el.covered) return { ...fail(`[${a.id}] ${label(el)} is covered by ${el.covered}; dismiss or scroll past it first`), cover: { label: el.covered, ids: el.cover?.ids ?? [], text: el.cover?.text ?? '' } }
          if (el.tag === 'select') return fail(`[${a.id}] is a native select; use op "select" with a value`)
          await this.clickAt(el.x, el.y)
          await this.settle()
          return { ok: true, line: `clicked [${a.id}] ${label(el)}`, delivered: true }
        }
        case 'hover': {
          if (a.id == null) return fail('hover needs an id')
          const r = await this.resolve(a.id)
          if (!r.ok) return fail(r.error!)
          const el = r as Resolved
          await this.mouse('mouseMoved', el.x, el.y)
          await this.settle()
          return { ok: true, line: `hovered [${a.id}] ${label(el)}`, delivered: true }
        }
        case 'select': {
          if (a.id == null) return fail('select needs an id')
          const want = a.value ?? a.text
          if (want == null) return fail('select needs a value')
          const r = await this.resolve(a.id)
          if (!r.ok) return fail(r.error!)
          const el = r as Resolved
          if (el.tag !== 'select') return fail(`[${a.id}] is not a native select (it is a ${el.role}); click it and then click the option`)
          const s = await this.call<{ ok: boolean; error?: string; chosen?: string }>('setSelect', a.id, want)
          if (!s.ok) return fail(`[${a.id}] ${s.error}`)
          await this.settle()
          return { ok: true, line: `selected "${s.chosen}" in [${a.id}] ${label(el)}`, delivered: true }
        }
        case 'type': {
          const text = a.text ?? ''
          if (a.id == null) {
            // Type into whatever has focus.
            if (text) await this.send('Input.insertText', { text })
            if (a.enter) await this.key('Enter')
            await this.settle()
            return { ok: true, line: `typed "${preview(text)}"${a.enter ? ' and pressed Enter' : ''} into the focused field`, delivered: true }
          }
          const r = await this.resolve(a.id)
          if (!r.ok) return fail(r.error!)
          const el = r as Resolved
          if (el.disabled) return fail(`[${a.id}] ${label(el)} is disabled`)
          if (el.tag === 'select') {
            const s = await this.call<{ ok: boolean; error?: string; chosen?: string }>('setSelect', a.id, text)
            if (!s.ok) return fail(`[${a.id}] ${s.error}`)
            await this.settle()
            return { ok: true, line: `selected "${s.chosen}" in [${a.id}] ${label(el)}`, delivered: true }
          }
          if (el.type && VALUE_INPUTS.has(el.type)) {
            const s = await this.call<{ ok: boolean; value?: string }>('setValue', a.id, text)
            await this.settle()
            return { ok: s.ok, line: `set [${a.id}] ${label(el)} to "${s.value}"`, delivered: true }
          }
          if (!el.editable) return fail(`[${a.id}] ${label(el)} is not a text field`)
          if (el.covered) return { ...fail(`[${a.id}] ${label(el)} is covered by ${el.covered}; dismiss or scroll past it first`), cover: { label: el.covered, ids: el.cover?.ids ?? [], text: el.cover?.text ?? '' } }
          await this.clickAt(el.x, el.y)
          const p = await this.call<{ ok: boolean; hasContent: boolean }>('prepareType', a.id, a.clear !== false)
          if (!p.ok) return fail(`[${a.id}] disappeared after it was clicked`, true)
          if (text) await this.send('Input.insertText', { text })
          else if (p.hasContent && a.clear !== false) await this.key('Backspace')
          if (a.enter) await this.key('Enter')
          await this.settle()
          return { ok: true, line: `typed "${preview(text)}"${a.enter ? ' and pressed Enter' : ''} into [${a.id}] ${label(el)}`, delivered: true }
        }
        case 'press': {
          if (!a.key) return fail('press needs a key')
          if (a.id != null) {
            const r = await this.resolve(a.id)
            if (!r.ok) return fail(r.error!)
            await this.call('prepareType', a.id, false)
          }
          if (!(await this.key(a.key))) return fail(`unknown key "${a.key}"`)
          await this.settle()
          return { ok: true, line: `pressed ${a.key}`, delivered: true }
        }
        case 'scroll': {
          const dir = a.direction ?? 'down'
          if (dir === 'top' || dir === 'bottom') {
            await this.call('scrollTo', dir)
          } else {
            const snap = this.last ?? (await this.snapshot())
            let x = snap.vw / 2
            let y = snap.vh / 2
            if (a.id != null) {
              const r = await this.resolve(a.id)
              if (!r.ok) return fail(r.error!)
              x = (r as Resolved).x
              y = (r as Resolved).y
            }
            const amount = Math.round(snap.vh * 0.8) * (dir === 'up' ? -1 : 1)
            await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: amount })
          }
          await this.settle()
          return { ok: true, line: `scrolled ${dir}`, delivered: true }
        }
        case 'wait': {
          if (a.for?.length) {
            const results = await this.expect(a.for, a.ms ?? 8000)
            const bad = results.filter((r) => !r.ok)
            if (bad.length) return { ok: false, line: `waited ${a.ms ?? 8000}ms but: ${bad.map((b) => b.why).join('; ')}`, delivered: true }
            return { ok: true, line: 'condition met', delivered: true }
          }
          await sleep(Math.min(a.ms ?? 500, 10_000))
          await this.settle()
          return { ok: true, line: `waited ${a.ms ?? 500}ms`, delivered: true }
        }
        case 'dialog': {
          if (!this.pendingDialog) return fail('no javascript dialog is open')
          const d = this.pendingDialog
          await this.send('Page.handleJavaScriptDialog', { accept: a.accept !== false, promptText: a.text })
          this.pendingDialog = null
          await this.settle()
          return { ok: true, line: `${a.accept !== false ? 'accepted' : 'dismissed'} ${d.type} dialog "${preview(d.message)}"`, delivered: true }
        }
      }
      return fail(`unknown op "${(a as Action).op}"`)
    } catch (e) {
      // Input may have been sent before the failure, so this must not be retried blindly.
      return { ok: false, line: `${a.op} failed: ${(e as Error).message}`, delivered: true }
    }
  }

  // ---- reading and looking -------------------------------------------------------

  read(opts: { scope?: number; grep?: string; maxChars?: number; offset?: number; full?: boolean }): Promise<{ ok: boolean; error?: string; url: string; title: string; text: string; total: number; shown: number; offset: number; more: boolean; matches?: number }> {
    return this.call('read', opts)
  }

  find(query: string, limit = 12): Promise<Snapshot['nodes']> {
    return this.call('find', query, limit)
  }

  /** JPEG screenshot of the viewport (or a region of it), base64-encoded. */
  async look(opts: { scale?: number; region?: { x: number; y: number; width: number; height: number } } = {}): Promise<string> {
    await this.attach()
    const snap = this.last ?? (await this.snapshot())
    const region = opts.region ?? { x: 0, y: 0, width: snap.vw, height: snap.vh }
    const shot = this.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 62,
      optimizeForSpeed: true,
      clip: { ...region, scale: opts.scale ?? 0.6 },
    }).then((r) => r.data as string)
    // A tab that is not being painted never answers a protocol screenshot; fall back to the browser's own capture.
    const timeout = sleep(3500).then(() => null)
    return (await Promise.race([shot, timeout])) ?? this.nav.capture()
  }

  /** Run JavaScript in the page's own world and return its JSON result. */
  async evaluate(code: string, timeoutMs = 10_000): Promise<{ ok: boolean; value: string }> {
    await this.attach()
    const expression = `(async () => { ${code}\n})()`
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: timeoutMs })
    if (r.exceptionDetails) {
      return { ok: false, value: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n').slice(0, 3).join('\n') }
    }
    const v = r.result.value
    return { ok: true, value: v === undefined ? 'undefined' : typeof v === 'string' ? v : JSON.stringify(v, null, 1) }
  }

  describe(id: number): Promise<Record<string, string | undefined> | null> {
    return this.call('describe', id)
  }

  locate(fingerprint: object): Promise<{ id: number; score: number; ambiguous: boolean } | null> {
    return this.call('locate', fingerprint)
  }
}

function preview(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}
