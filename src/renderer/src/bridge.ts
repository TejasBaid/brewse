interface Bridge {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
  on(channel: string, listener: (data: any) => void): () => void
}

declare global {
  interface Window {
    brewse: Bridge
  }
}

export const bridge: Bridge = window.brewse

/** Call a method in the core process (agent, history, routines). */
export function core<T = unknown>(method: string, params?: unknown): Promise<T> {
  return bridge.invoke<T>('core:call', { method, params })
}
