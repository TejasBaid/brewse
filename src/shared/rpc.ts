// Minimal request/response + event channel used between the main process and
// the core utility process. Transport-agnostic: give it a `post` function and
// feed incoming messages to `receive`.

type Handler = (params: any) => unknown | Promise<unknown>
type Listener = (data: any) => void

interface Req { t: 'req'; id: number; method: string; params: unknown }
interface Res { t: 'res'; id: number; ok: boolean; result?: unknown; error?: string }
interface Evt { t: 'evt'; name: string; data: unknown }
export type RpcMessage = Req | Res | Evt

export class Rpc {
  private seq = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private handlers = new Map<string, Handler>()
  private listeners = new Map<string, Set<Listener>>()

  constructor(private post: (m: RpcMessage) => void) {}

  handle(method: string, fn: Handler): void {
    this.handlers.set(method, fn)
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.post({ t: 'req', id, method, params })
    })
  }

  emit(name: string, data?: unknown): void {
    this.post({ t: 'evt', name, data })
  }

  on(name: string, fn: Listener): () => void {
    let set = this.listeners.get(name)
    if (!set) this.listeners.set(name, (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  }

  receive(m: RpcMessage): void {
    if (!m || typeof m !== 'object') return
    if (m.t === 'res') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.ok) p.resolve(m.result)
      else p.reject(new Error(m.error ?? 'rpc error'))
    } else if (m.t === 'req') {
      const fn = this.handlers.get(m.method)
      if (!fn) {
        this.post({ t: 'res', id: m.id, ok: false, error: `no handler for ${m.method}` })
        return
      }
      Promise.resolve()
        .then(() => fn(m.params))
        .then(
          (result) => this.post({ t: 'res', id: m.id, ok: true, result }),
          (e) => this.post({ t: 'res', id: m.id, ok: false, error: e?.message ?? String(e) }),
        )
    } else if (m.t === 'evt') {
      this.listeners.get(m.name)?.forEach((fn) => {
        try {
          fn(m.data)
        } catch (e) {
          console.error('[rpc] listener error', m.name, e)
        }
      })
    }
  }
}
