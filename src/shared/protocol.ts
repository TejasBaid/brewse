// Types shared by the main process, the core process and the UI.

export type TabOwner = 'user' | 'agent'

export interface TabInfo {
  id: string
  title: string
  url: string
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  owner: TabOwner
  /** 'default' is the user's logged-in profile; anything else is an ephemeral logged-out agent profile. */
  profile: string
  /** Agent session that owns this tab, if any. */
  session?: string
  /** True while the agent is acting on this tab. */
  busy?: boolean
  asleep?: boolean
}

export interface TabsState {
  tabs: TabInfo[]
  activeId: string | null
}

/** Width of the border drawn around a page that is being worked on. The page is inset by this much to make room for it. */
export const WORK_BORDER = 3
/** The most pages a task view shows live at once: one large, the rest small beneath it. */
export const MAX_TILES = 5

export interface Tile {
  id: string
  /** The tile's frame, header included, in window coordinates. */
  x: number
  y: number
  width: number
  height: number
  /** Height of the strip above the page that carries its name. */
  header: number
  /** The first tile is the large one. */
  primary: boolean
}

export interface Layout {
  sidebar: number
  panel: number
  sidebarVisible: boolean
  /** 'browse' shows a page. 'chat' shows a task: its conversation, with the pages it is working in beside it. 'overview' shows every tab at once. 'tasks' lists every task there has been. */
  mode: 'browse' | 'chat' | 'overview' | 'tasks'
  /** In a task view, the tab shown largest among the task's live pages. */
  peek: string | null
  /** In a task view, every tab the task is working in, shown live beside the conversation. The first is the large one. */
  peeks: string[]
  /** Where each of those live pages is drawn, in window coordinates. Worked out by the main process. */
  tiles: Tile[]
  /** The page in view is being worked on: it is drawn slightly inset so a border can show around it. */
  frame: boolean
}

export interface CreateTabOptions {
  url?: string
  owner?: TabOwner
  profile?: string
  session?: string
  /** Bring the tab to the front. Agent tabs default to background. */
  activate?: boolean
  opener?: string
}

export type OverlayMode = 'new-tab' | 'address' | 'ask'

// ---- Agent events streamed from core to the UI --------------------------------

export type AgentEvent =
  | { type: 'session'; session: string; title: string; status: AgentStatus; mode: EffortMode }
  | { type: 'user'; session: string; text: string }
  /** The task started working on a tab the user already had open (a question about that page). */
  | { type: 'attach'; session: string; tab: string }
  | { type: 'text'; session: string; id: string; delta: string }
  | { type: 'thinking'; session: string; id: string; delta: string }
  /** One thing the agent did. `worker` is set when a sub-agent did it; `tab` is the tab it was done in. */
  | { type: 'step'; session: string; id: string; tool: string; summary: string; status: 'run' | 'ok' | 'error'; detail?: string; by?: 'claude' | 'jev' | 'code'; worker?: string; tab?: string }
  /** Files the task has made, listed when it finishes. */
  | { type: 'files'; session: string; folder: string; files: { path: string; name: string; size: number }[] }
  /** A sub-agent working on one part of the task, in its own tab, alongside others. */
  | { type: 'worker'; session: string; worker: string; label?: string; status: 'running' | 'done' }
  | { type: 'approval'; session: string; id: string; summary: string; detail: string }
  | { type: 'done'; session: string; ok: boolean; result?: string; ms: number; cost?: number; jev?: JevShare }
  | { type: 'error'; session: string; message: string }

/** One entry in a task's record: something said, something done, a question asked of the user, or the outcome. */
export type TaskItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'step'; id: string; tool: string; summary: string; status: 'run' | 'ok' | 'error'; detail?: string; by?: 'claude' | 'jev' | 'code'; worker?: string; tab?: string }
  | { kind: 'approval'; id: string; summary: string; detail: string; answered?: 'allow' | 'deny' }
  | { kind: 'result'; ok: boolean; ms: number; cost?: number; jev?: JevShare }
  | { kind: 'error'; text: string }
  | { kind: 'files'; folder: string; files: { path: string; name: string; size: number }[] }

/** A sub-agent working on one part of a task. */
export interface TaskWorker {
  id: string
  /** What it was asked to do, in a few words. */
  label?: string
  status: 'running' | 'done'
}

/** A task as it is listed: enough to show a line for it. */
export interface TaskSummary {
  id: string
  title: string
  status: AgentStatus
  mode: EffortMode
  created: number
  /** When it last finished, or was last asked something. */
  at: number
  /** The opening statement of its latest answer. */
  headline: string
  steps: number
  ms: number
  /** The page it was asked on, for a conversation that belongs to a page. */
  pageUrl?: string
}

/** A task in full, as it is kept on disk. */
export interface TaskRecord extends TaskSummary {
  items: TaskItem[]
  workers: TaskWorker[]
}

export type AgentStatus = 'running' | 'waiting' | 'done' | 'error' | 'stopped'
/** What Jev did for one request: the judgments it made so that Claude did not have to. */
export interface JevShare {
  decisions: number
  ms: number
  /** Characters of page text Jev went through and kept from Claude as beside the point. */
  spared: number
  /** Pages it chose the relevant parts of. */
  reads: number
  /** Controls it found from a description. */
  grounded: number
  /** Notices it closed that lay over a control. */
  cleared: number
  /** Statements about a page it judged. */
  checks: number
  /** How it sized the request up before Claude began. */
  size?: 'quick' | 'standard' | 'deep'
}

export type EffortMode = 'auto' | 'fast' | 'balanced' | 'thorough'

export interface Suggestion {
  kind: 'ask' | 'go' | 'search' | 'history' | 'tab' | 'routine'
  title: string
  detail?: string
  url?: string
  tabId?: string
  routine?: string
}

export const DEFAULT_PROFILE = 'default'
export const MCP_DEFAULT_PORT = 47821
