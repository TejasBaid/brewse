import type { CreateTabOptions, TabInfo, TabsState } from '../../shared/protocol'
import type { Rpc } from '../../shared/rpc'
import { Page } from './page'

/** The core's handle on the browser: tabs live in the main process, and this reaches them over RPC. */
export class BrowserHost {
  private pages = new Map<string, Page>()
  private busyTimers = new Map<string, NodeJS.Timeout>()

  constructor(readonly main: Rpc) {
    main.on('cdp', ({ id, method, params }) => this.pages.get(id)?.onEvent(method, params))
    main.on('cdp.detached', ({ id }) => this.pages.get(id)?.onDetached())
    main.on('tab.closed', ({ id }) => this.pages.delete(id))
    main.on('tab.opened', ({ id, opener }) => this.pages.get(opener)?.openedTabs.push(id))
  }

  async page(tabId: string): Promise<Page> {
    let page = this.pages.get(tabId)
    if (!page) {
      await this.main.call('cdp.attach', { id: tabId })
      const send = (method: string, params?: object, sessionId?: string) => {
        // A protocol call that never answers must surface as an error, not a hang.
        let timer: NodeJS.Timeout
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timed out; the tab is not responding`)), 30_000)
        })
        return Promise.race([this.main.call('cdp.send', { id: tabId, method, params, sessionId }), timeout]).finally(() => clearTimeout(timer))
      }
      page = new Page(tabId, send, {
        back: () => this.main.call('tabs.back', { id: tabId }),
        forward: () => this.main.call('tabs.forward', { id: tabId }),
        reload: () => this.main.call('tabs.reload', { id: tabId }),
        capture: () => this.main.call<string>('tabs.capture', { id: tabId }),
      })
      this.pages.set(tabId, page)
    }
    await page.attach()
    return page
  }

  createTab(opts: CreateTabOptions): Promise<TabInfo> {
    return this.main.call('tabs.create', opts)
  }

  closeTab(id: string): Promise<void> {
    return this.main.call('tabs.close', { id })
  }

  activate(id: string): Promise<void> {
    return this.main.call('tabs.activate', { id })
  }

  tabs(): Promise<TabsState> {
    return this.main.call('tabs.list')
  }

  tab(id: string): Promise<TabInfo | null> {
    return this.main.call('tabs.get', { id })
  }

  /** Show the tab as being worked on; clears itself shortly after the last action. */
  touch(id: string): void {
    const existing = this.busyTimers.get(id)
    if (existing) clearTimeout(existing)
    else void this.main.call('tabs.setBusy', { id, busy: true }).catch(() => {})
    this.busyTimers.set(
      id,
      setTimeout(() => {
        this.busyTimers.delete(id)
        void this.main.call('tabs.setBusy', { id, busy: false }).catch(() => {})
      }, 1800),
    )
  }
}
