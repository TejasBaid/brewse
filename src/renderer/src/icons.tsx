import type { JSX } from 'solid-js'

const base = (path: JSX.Element, size = 16, stroke = 1.6) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {path}
  </svg>
)

export const Icon = {
  back: () => base(<path d="M15 5l-7 7 7 7" />),
  forward: () => base(<path d="M9 5l7 7-7 7" />),
  reload: () => base(<><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4v5h-5" /></>),
  stop: () => base(<path d="M6 6l12 12M18 6L6 18" />),
  close: () => base(<path d="M7 7l10 10M17 7L7 17" />, 14),
  sidebar: () => base(<><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M9.5 4.5v15" /></>),
  chevron: () => base(<path d="M9 6l6 6-6 6" />, 12, 2),
}
