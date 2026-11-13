import { render } from 'solid-js/web'
import { Window } from './Window'
import { initDevshot } from './devshot'
import { CommandBar } from './CommandBar'
import { Dock } from './Dock'
import './app.css'

const route = location.hash.replace(/^#\/?/, '') || 'chrome'
document.documentElement.dataset.route = route
initDevshot()
// Development builds keep a short local record of where clicks landed (the element's tag and class,
// never what is on a page or typed), so "that button does nothing" can be checked afterwards.
{
  document.addEventListener(
    'mousedown',
    (e) => {
      const t = e.target as Element | null
      const what = t ? `${t.tagName.toLowerCase()}.${String((t as SVGElement).className?.baseVal ?? t.className).trim().split(/\s+/).join('.')}` : 'nothing'
      void window.brewse.invoke('app:click-log', `${route} ${e.clientX},${e.clientY} ${what}`).catch(() => {})
    },
    true,
  )
}
// The top layer holds two things that are never visible together: the command bar and the dock.
render(
  () =>
    route === 'overlay' ? (
      <>
        <CommandBar />
        <Dock />
      </>
    ) : (
      <Window />
    ),
  document.getElementById('root')!,
)
