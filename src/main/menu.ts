import { Menu, app, type MenuItemConstructorOptions } from 'electron'
import type { Shell } from './shell'
import type { TabManager } from './tabs'

export function installMenu(shell: Shell, tabs: TabManager, actions: { togglePanel: () => void; overview: () => void; tasks: () => void; settings: () => void; ask: () => void; newTab: () => void; address: () => void }): void {
  const active = () => tabs.activeId
  const cycle = (dir: 1 | -1) => {
    const { tabs: list, activeId } = tabs.state()
    const visible = list.filter((t) => t.owner === 'user' || t.id === activeId)
    if (visible.length < 2) return
    const i = visible.findIndex((t) => t.id === activeId)
    tabs.activate(visible[(i + dir + visible.length) % visible.length].id)
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'Cmd+,', click: actions.settings }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'Cmd+T', click: actions.newTab },
        { label: 'Ask Brewse…', accelerator: 'Cmd+K', click: actions.ask },
        { label: 'Open Location…', accelerator: 'Cmd+L', click: actions.address },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'Cmd+W',
          click: () => {
            if (shell.overlayOpen) shell.hideOverlay()
            else if (active()) tabs.close(active()!)
          },
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'Cmd+R', click: () => active() && tabs.reload(active()!) },
        { label: 'All Tabs', accelerator: 'Shift+Cmd+\\', click: actions.overview },
        { label: 'Tasks', accelerator: 'Shift+Cmd+K', click: actions.tasks },
        { label: 'Conversation Beside Page', accelerator: 'Cmd+J', click: actions.togglePanel },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'Cmd+0', click: () => tabs.active()?.view?.webContents.setZoomLevel(0) },
        { label: 'Zoom In', accelerator: 'Cmd+Plus', click: () => zoom(tabs, 0.5) },
        { label: 'Zoom Out', accelerator: 'Cmd+-', click: () => zoom(tabs, -0.5) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'Alt+Cmd+I', click: () => tabs.active()?.view?.webContents.openDevTools({ mode: 'detach' }) },
        { label: 'Inspect Brewse UI', accelerator: 'Alt+Cmd+U', click: () => shell.ui.webContents.openDevTools({ mode: 'detach' }) },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'Cmd+[', click: () => active() && tabs.back(active()!) },
        { label: 'Forward', accelerator: 'Cmd+]', click: () => active() && tabs.forward(active()!) },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => cycle(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => cycle(-1) },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i): MenuItemConstructorOptions => ({
          label: `Tab ${i + 1}`,
          accelerator: `Cmd+${i + 1}`,
          click: () => {
            const user = tabs.state().tabs.filter((t) => t.owner === 'user')
            const target = i === 8 ? user[user.length - 1] : user[i]
            if (target) tabs.activate(target.id)
          },
        })),
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function zoom(tabs: TabManager, delta: number): void {
  const wc = tabs.active()?.view?.webContents
  if (wc) wc.setZoomLevel(wc.getZoomLevel() + delta)
}
