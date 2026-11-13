export interface ElNode {
  k: 'e'
  id: number
  role: string
  name: string
  tag: string
  x: number
  y: number
  w: number
  h: number
  inView: boolean
  value?: string
  states?: string[]
  type?: string
  href?: string
  options?: string[]
  moreOptions?: number
  /** Clickable only by a pointer-cursor heuristic, not by markup. */
  weak?: boolean
  isNew?: boolean
}

export interface HeadingNode {
  k: 'h'
  level: number
  text: string
  y: number
  inView: boolean
}

export interface FrameNode {
  k: 'f'
  src: string
  name: string
  x: number
  y: number
  w: number
  h: number
}

export type SnapNode = ElNode | HeadingNode | FrameNode

export interface PageStats {
  interactive: number
  unlabeled: number
  duplicates: number
  canvases: number
  crossOriginFrames: number
  shadowHosts: number
  customWidgets: number
  modal: string
}

export interface Snapshot {
  docId: string
  url: string
  title: string
  ready: string
  vw: number
  vh: number
  scrollY: number
  scrollMax: number
  nodes: SnapNode[]
  stats: PageStats
  truncated: boolean
  sig: string
  text?: string
}

/** A plain, checkable statement about the page, written before an action is taken. */
export type Expectation =
  | { url: string }
  | { url_matches: string }
  | { title: string }
  | { text: string }
  | { no_text: string }
  | { element: string; role?: string }
  | { no_element: string; role?: string }
  | { value: string; id?: number; field?: string }
  | { state: string; id: number }
  | { jev: string }

export interface Action {
  op: 'click' | 'type' | 'select' | 'press' | 'hover' | 'scroll' | 'goto' | 'back' | 'forward' | 'reload' | 'wait' | 'dialog'
  /** Element id from the latest state. */
  id?: number
  /** Or a description of the element, grounded by Jev. */
  target?: string
  /** Why this action is being taken; logged, and used to score Jev in shadow mode. */
  intent?: string
  text?: string
  value?: string
  key?: string
  enter?: boolean
  clear?: boolean
  url?: string
  direction?: 'down' | 'up' | 'top' | 'bottom'
  x?: number
  y?: number
  ms?: number
  accept?: boolean
  for?: Expectation[]
  expect?: Expectation[]
  /** True when the action cannot be undone (purchase, send, delete, submit of real data). */
  irreversible?: boolean
}

export interface Receipt {
  ok: boolean
  /** One line describing what happened, written for the model. */
  line: string
  effect?: 'navigated' | 'changed' | 'none'
  /** Whether input reached the page. `false` means nothing happened and the action is safe to retry. */
  delivered: boolean
  by?: 'claude' | 'jev' | 'code'
  /** Set when a click was not sent because something lies over the control: what it is and the controls inside it. */
  cover?: { label: string; ids: number[]; text: string }
}
