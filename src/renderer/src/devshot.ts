import { bridge } from './bridge'

// Development aid. A WebContentsView capture contains only its own layer, so for
// screenshots the main process sends the page image and this draws it where the
// tab view sits, over a stand-in for the desktop behind the window.
export function initDevshot(): void {
  bridge.on('app:devshot', ({ page, card }: { page: string | null; card: { x: number; y: number; width: number; height: number } }) => {
    document.documentElement.classList.add('devshot')
    if (!page) return
    const img = document.createElement('img')
    img.src = page
    Object.assign(img.style, {
      position: 'fixed',
      left: `${card.x}px`,
      top: `${card.y}px`,
      width: `${card.width}px`,
      height: `${card.height}px`,
      borderRadius: '12px',
      objectFit: 'cover',
      objectPosition: 'top left',
      zIndex: document.documentElement.dataset.route === 'overlay' ? '-1' : '5',
    })
    document.body.appendChild(img)
  })
}
