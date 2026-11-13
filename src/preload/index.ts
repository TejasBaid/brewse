import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// The UI talks to the main process through one narrow, generic bridge.
// Only channels with these prefixes are allowed in either direction.
const INVOKE = /^(tabs|layout|overlay|dock|core|app):/
const LISTEN = /^(tabs|layout|overlay|dock|core|app):|^layout$/

contextBridge.exposeInMainWorld('brewse', {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!INVOKE.test(channel)) return Promise.reject(new Error(`blocked channel ${channel}`))
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel: string, listener: (data: unknown) => void): () => void {
    if (!LISTEN.test(channel)) throw new Error(`blocked channel ${channel}`)
    const wrapped = (_e: IpcRendererEvent, data: unknown) => listener(data)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
  },
})
