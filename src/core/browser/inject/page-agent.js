// Brewse page agent. Injected into an isolated world of every document the agent
// touches, so page scripts can neither see it nor interfere with it. It is plain
// JavaScript (imported as text) and exposes one object, __brewse, whose methods
// are called over the DevTools Protocol. Everything it returns is JSON.
(() => {
  if (globalThis.__brewse) return

  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'summary', 'option',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=switch]', '[role=tab]',
    '[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]', '[role=option]', '[role=combobox]',
    '[role=textbox]', '[role=searchbox]', '[role=spinbutton]', '[role=slider]', '[role=treeitem]', '[role=gridcell]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',')
  const HEADING = 'h1,h2,h3,h4,h5,h6,[role=heading]'
  const MAX_NODES = 2500

  const ids = new WeakMap() // Element -> id
  const refs = new Map() // id -> WeakRef<Element>
  const docId = Math.random().toString(36).slice(2, 10)
  let nextId = 1
  let previous = new Set()
  let snapshots = 0

  const clip = (s, n) => {
    s = String(s ?? '').replace(/\s+/g, ' ').trim()
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }

  function idFor(el) {
    let id = ids.get(el)
    if (!id) {
      id = nextId++
      ids.set(el, id)
      refs.set(id, new WeakRef(el))
    }
    return id
  }

  function elementOf(id) {
    const el = refs.get(Number(id))?.deref()
    return el && el.isConnected ? el : null
  }

  // An element with `display: contents` has no box of its own, so the browser reports it as
  // not visible, yet everything inside it is drawn. Sites wrap whole articles in one.
  const boxless = (el) => getComputedStyle(el).display === 'contents'

  function isVisible(el) {
    if (!el.isConnected) return false
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    const r = el.getBoundingClientRect()
    return r.width >= 2 && r.height >= 2
  }

  function frameOffset(el) {
    let x = 0
    let y = 0
    let win = el.ownerDocument.defaultView
    while (win && win !== window && win.frameElement) {
      const f = win.frameElement
      const r = f.getBoundingClientRect()
      x += r.left + f.clientLeft
      y += r.top + f.clientTop
      win = win.parent
    }
    return { x, y }
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.trim().split(/\s+/)[0]
    switch (el.tagName) {
      case 'A': return 'link'
      case 'BUTTON': case 'SUMMARY': return 'button'
      case 'SELECT': return el.multiple ? 'listbox' : 'combobox'
      case 'TEXTAREA': return 'textbox'
      case 'OPTION': return 'option'
      case 'INPUT': {
        const t = (el.getAttribute('type') || 'text').toLowerCase()
        if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button'
        if (t === 'checkbox') return 'checkbox'
        if (t === 'radio') return 'radio'
        if (t === 'range') return 'slider'
        if (t === 'number') return 'spinbutton'
        if (t === 'search') return 'searchbox'
        if (t === 'file') return 'file'
        if (t === 'hidden') return null
        return el.hasAttribute('list') ? 'combobox' : 'textbox'
      }
    }
    if (el.isContentEditable) return 'textbox'
    return 'clickable'
  }

  function textOf(el) {
    return (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
  }

  function nameOf(el) {
    const doc = el.ownerDocument
    const labelledby = el.getAttribute('aria-labelledby')
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => textOf(doc.getElementById(id) || {})).join(' ').trim()
      if (t) return t
    }
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const label = el.labels && el.labels[0] ? textOf(el.labels[0]) : ''
      if (label) return label
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (tag === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset')) return el.value || type
      return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || ''
    }
    const text = textOf(el)
    if (text) return text
    const img = el.querySelector('img[alt]')
    if (img && img.getAttribute('alt')) return img.getAttribute('alt')
    const inner = el.querySelector('[aria-label],[title]')
    if (inner) return inner.getAttribute('aria-label') || inner.getAttribute('title') || ''
    const svgTitle = el.querySelector('svg title')
    if (svgTitle) return svgTitle.textContent || ''
    return el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || ''
  }

  function valueOf(el) {
    const tag = el.tagName
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'password') return el.value ? '•'.repeat(Math.min(8, el.value.length)) : ''
      if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit' || type === 'file') return undefined
      return el.value
    }
    if (tag === 'TEXTAREA') return el.value
    if (tag === 'SELECT') return el.selectedOptions[0] ? textOf(el.selectedOptions[0]) : ''
    if (el.isContentEditable) return textOf(el)
    const now = el.getAttribute('aria-valuenow') ?? el.getAttribute('aria-valuetext')
    return now ?? undefined
  }

  function statesOf(el) {
    const s = []
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled')
    const checked = el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.getAttribute('aria-checked')
    if (checked === true || checked === 'true') s.push('checked')
    if (checked === 'mixed') s.push('mixed')
    const expanded = el.getAttribute('aria-expanded')
    if (expanded === 'true') s.push('expanded')
    if (expanded === 'false') s.push('collapsed')
    if (el.getAttribute('aria-selected') === 'true' || (el.tagName === 'OPTION' && el.selected)) s.push('selected')
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed')
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') s.push('current')
    if (el.required || el.getAttribute('aria-required') === 'true') s.push('required')
    if (el.readOnly) s.push('readonly')
    if (el.getAttribute('aria-invalid') === 'true') s.push('invalid')
    if (el.ownerDocument.activeElement === el) s.push('focused')
    return s
  }

  function shortHref(el) {
    const raw = el.getAttribute('href')
    if (!raw || raw.startsWith('javascript:')) return undefined
    try {
      const u = new URL(raw, el.ownerDocument.baseURI)
      if (u.origin === location.origin) return clip(u.pathname + u.search + u.hash, 70)
      return clip(u.host + u.pathname, 70)
    } catch {
      return undefined
    }
  }

  // For a checkbox or radio that is visually hidden behind a styled label, the label is what a person clicks.
  function clickTarget(el) {
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio') && !isVisible(el)) {
      const label = (el.labels && el.labels[0]) || el.closest('label')
      if (label && isVisible(label)) return label
    }
    return el
  }

  /** Walk a document (and same-origin frames and open shadow roots) in document order. */
  function walk(root, visit, budget) {
    const all = root.querySelectorAll('*')
    for (let i = 0; i < all.length; i++) {
      if (budget.left <= 0) return
      const el = all[i]
      visit(el)
      if (el.shadowRoot) walk(el.shadowRoot, visit, budget)
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let doc = null
        try {
          doc = el.contentDocument
        } catch {}
        if (doc && doc.documentElement) walk(doc, visit, budget)
        else budget.frames.push(el)
      }
    }
  }

  function collect(opts = {}) {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nodes = []
    const budget = { left: MAX_NODES, frames: [] }
    const stats = { interactive: 0, unlabeled: 0, duplicates: 0, canvases: 0, crossOriginFrames: 0, shadowHosts: 0, customWidgets: 0, modal: '' }
    const seenNames = new Map()
    const accepted = new Set()

    const add = (el, pointerOnly) => {
      const target = clickTarget(el)
      if (!isVisible(target)) return
      const role = roleOf(el)
      if (!role) return
      // An <option> is reported through its <select>.
      if (el.tagName === 'OPTION' && el.closest('select')) return
      const off = frameOffset(target)
      const r = target.getBoundingClientRect()
      const x = r.left + off.x
      const y = r.top + off.y
      const inView = x < vw && y < vh && x + r.width > 0 && y + r.height > 0
      if (opts.viewportOnly && !inView) return
      const name = clip(nameOf(el), 90)
      const id = idFor(el)
      const node = { k: 'e', id, role, name, tag: el.tagName.toLowerCase(), x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height), inView }
      const value = valueOf(el)
      if (value !== undefined && value !== '') node.value = clip(value, 100)
      const states = statesOf(el)
      if (states.length) node.states = states
      if (el.tagName === 'INPUT') node.type = (el.getAttribute('type') || 'text').toLowerCase()
      if (el.tagName === 'A') {
        const href = shortHref(el)
        if (href) node.href = href
      }
      if (el.tagName === 'SELECT') {
        const options = Array.from(el.options)
        node.options = options.slice(0, 12).map((o) => clip(textOf(o), 40))
        if (options.length > 12) node.moreOptions = options.length - 12
      }
      if (pointerOnly) node.weak = true
      if (snapshots > 0 && !previous.has(id)) node.isNew = true
      nodes.push(node)
      accepted.add(el)
      budget.left--
      stats.interactive++
      if (!name) stats.unlabeled++
      else {
        const key = role + '|' + name.toLowerCase()
        const n = (seenNames.get(key) || 0) + 1
        seenNames.set(key, n)
        if (n === 2) stats.duplicates += 2
        else if (n > 2) stats.duplicates++
      }
      if (role === 'combobox' || role === 'listbox' || role === 'slider' || role === 'treeitem' || role === 'gridcell') stats.customWidgets++
    }

    let examined = 0
    walk(document, (el) => {
      const tag = el.tagName
      if (tag === 'CANVAS' && isVisible(el)) stats.canvases++
      if (el.shadowRoot) stats.shadowHosts++
      if ((tag === 'DIALOG' && el.open) || el.getAttribute('aria-modal') === 'true' || el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') {
        if (!stats.modal && isVisible(el)) stats.modal = clip(nameOf(el) || 'dialog', 60) || 'dialog'
      }
      if (el.matches(INTERACTIVE)) {
        add(el, false)
      } else if (el.matches(HEADING)) {
        if (isVisible(el)) {
          const text = clip(textOf(el), 100)
          if (text) {
            const off = frameOffset(el)
            const r = el.getBoundingClientRect()
            const y = r.top + off.y
            const level = Number(el.getAttribute('aria-level')) || Number(el.tagName[1]) || 2
            nodes.push({ k: 'h', level, text, y: Math.round(y), inView: y < vh && y + r.height > 0 })
          }
        }
      } else if (examined < 4000 && (tag === 'DIV' || tag === 'SPAN' || tag === 'LI' || tag === 'IMG' || tag === 'TD' || tag === 'svg' || tag === 'LABEL')) {
        // Elements made clickable only by script show a pointer cursor; report the outermost such element.
        examined++
        const r = el.getBoundingClientRect()
        if (r.width < 4 || r.height < 4 || r.bottom < -vh || r.top > vh * 2) return
        if (getComputedStyle(el).cursor !== 'pointer') return
        const parent = el.parentElement
        if (parent && getComputedStyle(parent).cursor === 'pointer') return
        if (el.closest(INTERACTIVE)) return
        if (el.querySelector(INTERACTIVE)) return
        add(el, true)
      }
    }, budget)

    for (const frame of budget.frames) {
      if (!isVisible(frame)) continue
      stats.crossOriginFrames++
      const off = frameOffset(frame)
      const r = frame.getBoundingClientRect()
      nodes.push({ k: 'f', src: clip(frame.getAttribute('src') || '', 80), name: clip(frame.getAttribute('title') || frame.getAttribute('name') || '', 60), x: Math.round(r.left + off.x), y: Math.round(r.top + off.y), w: Math.round(r.width), h: Math.round(r.height) })
    }

    return { nodes, stats, truncated: budget.left <= 0, vw, vh }
  }

  function hash(str) {
    let h = 5381
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
    return (h >>> 0).toString(36)
  }

  function viewportText(limit) {
    const out = []
    let size = 0
    const vh = window.innerHeight
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()) && size < limit) {
      const text = node.nodeValue.replace(/\s+/g, ' ').trim()
      if (text.length < 2) continue
      const parent = node.parentElement
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue
      const r = parent.getBoundingClientRect()
      if (r.bottom < 0 || r.top > vh || r.width === 0) continue
      if (parent.checkVisibility && !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
      out.push(text)
      size += text.length + 1
    }
    return out.join('\n').slice(0, limit)
  }

  function snapshot(opts = {}) {
    const c = collect(opts)
    const current = new Set()
    let sigSource = location.href
    for (const n of c.nodes) {
      if (n.k !== 'e') continue
      current.add(n.id)
      sigSource += '|' + n.id + n.role + n.name + (n.value ?? '') + (n.states ? n.states.join() : '')
    }
    previous = current
    snapshots++
    if (refs.size > 6000) for (const [id, ref] of refs) if (!ref.deref()) refs.delete(id)
    const doc = document.documentElement
    const result = {
      docId,
      url: location.href,
      title: document.title,
      ready: document.readyState,
      vw: c.vw,
      vh: c.vh,
      scrollY: Math.round(window.scrollY),
      scrollMax: Math.round(Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0)),
      nodes: c.nodes,
      stats: c.stats,
      truncated: c.truncated,
      sig: hash(sigSource),
    }
    if (opts.text) result.text = viewportText(opts.text === true ? 6000 : opts.text)
    return result
  }

  function deepElementFromPoint(x, y) {
    let doc = document
    let el = null
    for (let i = 0; i < 8; i++) {
      el = doc.elementFromPoint(x, y)
      if (!el) break
      while (el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y)
        if (!inner || inner === el) break
        el = inner
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let inner = null
        try {
          inner = el.contentDocument
        } catch {}
        if (!inner) break
        const r = el.getBoundingClientRect()
        x -= r.left + el.clientLeft
        y -= r.top + el.clientTop
        doc = inner
        continue
      }
      break
    }
    return el
  }

  function contains(a, b) {
    // Like a.contains(b), but crossing shadow boundaries.
    for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true
    return false
  }

  /** Scroll an element into view and report where to click it and whether anything is in the way. */
  function resolve(id, opts = {}) {
    const el = elementOf(id)
    if (!el) return { ok: false, error: 'gone' }
    const target = clickTarget(el)
    if (!isVisible(target)) return { ok: false, error: 'hidden' }
    let r = target.getBoundingClientRect()
    const off0 = frameOffset(target)
    const fullyIn = r.top + off0.y >= 0 && r.bottom + off0.y <= window.innerHeight && r.left + off0.x >= 0 && r.right + off0.x <= window.innerWidth
    if (!fullyIn && opts.scroll !== false) {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      r = target.getBoundingClientRect()
    }
    const off = frameOffset(target)
    // Click a point that is inside both the element and the viewport.
    const left = Math.max(0, r.left + off.x)
    const right = Math.min(window.innerWidth, r.right + off.x)
    const top = Math.max(0, r.top + off.y)
    const bottom = Math.min(window.innerHeight, r.bottom + off.y)
    if (right - left < 1 || bottom - top < 1) return { ok: false, error: 'offscreen' }
    const x = (left + right) / 2
    const y = (top + bottom) / 2
    const info = {
      ok: true,
      x: Math.round(x),
      y: Math.round(y),
      tag: el.tagName.toLowerCase(),
      type: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined,
      role: roleOf(el),
      name: clip(nameOf(el), 90),
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      editable: el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/.test(el.type)),
      href: el.tagName === 'A' ? el.href : undefined,
    }
    const hit = deepElementFromPoint(x, y)
    if (hit && hit !== target && !contains(target, hit) && !contains(el, hit)) {
      // A label wrapping the input, or the input's own label, is not an obstruction.
      const benign = (hit.tagName === 'LABEL' && (hit.control === el || contains(hit, el))) || contains(hit, target)
      if (!benign) {
        info.covered = clip((hit.tagName.toLowerCase() + ' ' + nameOf(hit)).trim(), 70)
        info.cover = coverOf(hit)
      }
    }
    return info
  }

  /**
   * What is lying over a control: the outermost layer the covering element belongs to
   * (a dialog, or something fixed or sticky on the page), a little of its text, and
   * the controls inside it, one of which usually closes it.
   */
  function coverOf(hit) {
    let root = hit
    for (let n = hit; n && n !== document.body && n !== document.documentElement; n = n.parentElement || (n.getRootNode() && n.getRootNode().host)) {
      const role = n.getAttribute && n.getAttribute('role')
      const pos = getComputedStyle(n).position
      if (pos === 'fixed' || pos === 'sticky' || role === 'dialog' || role === 'alertdialog' || n.tagName === 'DIALOG' || (n.getAttribute && n.getAttribute('aria-modal') === 'true')) root = n
    }
    const found = []
    const walk = (node) => {
      if (found.length >= 30) return
      for (const el of node.querySelectorAll('*')) {
        if (found.length >= 30) break
        const id = ids.get(el)
        if (id != null && isVisible(el)) found.push(id)
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    const own = ids.get(root)
    if (own != null) found.push(own)
    walk(root)
    return { ids: found, text: clip((root.innerText || '').replace(/\s+/g, ' ').trim(), 240) }
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
  }

  function setSelect(id, want) {
    const el = elementOf(id)
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'not a select' }
    const options = Array.from(el.options)
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase()
    const w = norm(want)
    const pick = options.find((o) => o.value === want) || options.find((o) => norm(textOf(o)) === w) || options.find((o) => norm(textOf(o)).includes(w)) || options.find((o) => norm(o.value) === w)
    if (!pick) return { ok: false, error: 'no option matching "' + want + '"; options: ' + options.slice(0, 15).map((o) => textOf(o)).join(' | ') }
    if (pick.disabled) return { ok: false, error: 'option is disabled' }
    el.value = pick.value
    pick.selected = true
    fire(el, 'input')
    fire(el, 'change')
    return { ok: true, chosen: textOf(pick) }
  }

  function setValue(id, value) {
    const el = elementOf(id)
    if (!el) return { ok: false, error: 'gone' }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    fire(el, 'input')
    fire(el, 'change')
    return { ok: true, value: el.value }
  }

  function prepareType(id, clear) {
    const el = elementOf(id)
    if (!el) return { ok: false, error: 'gone' }
    el.focus()
    if (clear) {
      if (typeof el.select === 'function') el.select()
      else if (el.isContentEditable) {
        const range = el.ownerDocument.createRange()
        range.selectNodeContents(el)
        const sel = el.ownerDocument.defaultView.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
    return { ok: true, hasContent: !!(el.value || (el.isContentEditable && textOf(el))) }
  }

  // ---- settling ---------------------------------------------------------------

  let lastMutation = performance.now()
  const styleSeen = new WeakMap()
  const observer = new MutationObserver((records) => {
    const now = performance.now()
    for (const m of records) {
      if (m.type === 'attributes') {
        // Animation loops rewrite style and class constantly; count each element at most once per 250ms.
        if (m.attributeName === 'style' || m.attributeName === 'class') {
          const seen = styleSeen.get(m.target) || 0
          if (now - seen < 250) continue
          styleSeen.set(m.target, now)
          if (seen) continue
        }
      }
      lastMutation = now
      return
    }
  })
  const observe = () => {
    if (document.documentElement) observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  }
  observe()
  if (!document.documentElement) document.addEventListener('readystatechange', observe, { once: true })

  /** Resolve once the DOM has been quiet for `quiet` ms, or after `cap` ms. */
  function waitQuiet(quiet, cap) {
    const start = performance.now()
    return new Promise((done) => {
      const tick = () => {
        const now = performance.now()
        if (now - lastMutation >= quiet) return done({ quiet: true, waited: Math.round(now - start), ready: document.readyState })
        if (now - start >= cap) return done({ quiet: false, waited: Math.round(now - start), ready: document.readyState })
        setTimeout(tick, Math.min(30, quiet - (now - lastMutation) + 1))
      }
      tick()
    })
  }

  // ---- expectations -------------------------------------------------------------

  function pageText() {
    return (document.body ? document.body.innerText : '') || ''
  }

  /** Evaluate plain, checkable statements about the page. Each returns { ok, why }. */
  function expect(list) {
    let text = null
    const lower = () => (text ??= pageText().toLowerCase())
    return list.map((e) => {
      try {
        if (e.url !== undefined) {
          const ok = location.href.includes(e.url)
          return { ok, why: ok ? '' : 'url is ' + location.href }
        }
        if (e.url_matches !== undefined) {
          const ok = new RegExp(e.url_matches).test(location.href)
          return { ok, why: ok ? '' : 'url is ' + location.href }
        }
        if (e.title !== undefined) {
          const ok = document.title.toLowerCase().includes(String(e.title).toLowerCase())
          return { ok, why: ok ? '' : 'title is "' + clip(document.title, 80) + '"' }
        }
        if (e.text !== undefined) {
          const ok = lower().includes(String(e.text).toLowerCase())
          return { ok, why: ok ? '' : 'text "' + clip(e.text, 60) + '" not on page' }
        }
        if (e.no_text !== undefined) {
          const ok = !lower().includes(String(e.no_text).toLowerCase())
          return { ok, why: ok ? '' : 'text "' + clip(e.no_text, 60) + '" is still on page' }
        }
        if (e.element !== undefined || e.no_element !== undefined) {
          const want = String(e.element ?? e.no_element).toLowerCase()
          const found = collect().nodes.some((n) => n.k === 'e' && (!e.role || n.role === e.role) && n.name.toLowerCase().includes(want))
          const ok = e.element !== undefined ? found : !found
          return { ok, why: ok ? '' : (found ? 'element "' : 'no element "') + clip(want, 60) + '"' + (found ? ' is still present' : '') }
        }
        if (e.value !== undefined) {
          const nodes = collect().nodes.filter((n) => n.k === 'e')
          const node = e.id ? nodes.find((n) => n.id === Number(e.id)) : nodes.find((n) => n.name.toLowerCase().includes(String(e.field ?? '').toLowerCase()) && n.value !== undefined)
          if (!node) return { ok: false, why: 'field not found' }
          const ok = String(node.value ?? '').toLowerCase().includes(String(e.value).toLowerCase())
          return { ok, why: ok ? '' : 'value is "' + clip(node.value ?? '', 60) + '"' }
        }
        if (e.state !== undefined) {
          const node = collect().nodes.find((n) => n.k === 'e' && n.id === Number(e.id))
          if (!node) return { ok: false, why: 'element not found' }
          const ok = (node.states || []).includes(e.state)
          return { ok, why: ok ? '' : 'states are [' + (node.states || []).join(', ') + ']' }
        }
        return { ok: false, why: 'unknown expectation ' + JSON.stringify(e) }
      } catch (err) {
        return { ok: false, why: String(err && err.message) }
      }
    })
  }

  // ---- reading ------------------------------------------------------------------

  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT|EMBED|HEAD|META|LINK|BUTTON|SELECT|INPUT|TEXTAREA|FORM-ASSOCIATED)$/i
  const CHROME_TAGS = /^(NAV|HEADER|FOOTER|ASIDE)$/
  const CHROME_ROLES = /^(navigation|banner|contentinfo|search|toolbar|menubar|tablist|complementary)$/
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|UL|OL|LI|TABLE|TR|H[1-6]|BLOCKQUOTE|PRE|DL|DT|DD|FIGURE|FIGCAPTION|DETAILS|SUMMARY|HR|BR|ADDRESS)$/

  function pickMain() {
    const candidates = document.querySelectorAll('main, [role=main], article, #content, #main, .content, .post, .article')
    let best = null
    let bestLen = 0
    for (const c of candidates) {
      if (!isVisible(c) && !boxless(c)) continue
      const len = (c.innerText || '').length
      if (len > bestLen) {
        best = c
        bestLen = len
      }
    }
    const bodyLen = document.body ? (document.body.innerText || '').length : 0
    // Only trust a "main" region if it holds a real share of the page's text.
    return best && bestLen > Math.max(400, bodyLen * 0.3) ? best : document.body
  }

  function toMarkdown(root, includeChrome) {
    const out = []
    const push = (s) => out.push(s)
    const inlineText = (node) => {
      let s = ''
      for (const child of node.childNodes) {
        if (child.nodeType === 3) s += child.nodeValue
        else if (child.nodeType === 1) {
          const tag = child.tagName
          if (SKIP.test(tag) && tag !== 'BUTTON') continue
          if (child.getAttribute('aria-hidden') === 'true') continue
          if (tag === 'BR') s += '\n'
          else if (tag === 'IMG') {
            const alt = child.getAttribute('alt')
            if (alt && alt.trim()) s += '[image: ' + clip(alt, 80) + ']'
          } else if (tag === 'A') {
            const t = inlineText(child).replace(/\s+/g, ' ').trim()
            const href = child.getAttribute('href')
            if (t && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
              let url = href
              try {
                const u = new URL(href, document.baseURI)
                url = u.origin === location.origin ? u.pathname + u.search : u.href
              } catch {}
              s += '[' + t + '](' + url + ')'
            } else s += t
          } else if (tag === 'CODE') s += '`' + child.textContent + '`'
          else s += inlineText(child)
        }
      }
      return s
    }
    const hasBlockChild = (el) => {
      for (const c of el.children) if (BLOCK.test(c.tagName) || c.tagName === 'TABLE') return true
      return false
    }
    const visit = (el) => {
      const tag = el.tagName
      if (SKIP.test(tag)) return
      if (!includeChrome && (CHROME_TAGS.test(tag) || CHROME_ROLES.test(el.getAttribute('role') || ''))) return
      if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !boxless(el)) return
      if (/^H[1-6]$/.test(tag)) {
        const t = inlineText(el).replace(/\s+/g, ' ').trim()
        if (t) push('\n' + '#'.repeat(Number(tag[1])) + ' ' + t + '\n')
        return
      }
      if (tag === 'PRE') {
        push('\n```\n' + el.textContent.replace(/\n+$/, '') + '\n```\n')
        return
      }
      if (tag === 'TABLE') {
        const rows = el.querySelectorAll('tr')
        const lines = []
        for (const row of rows) {
          const cells = Array.from(row.children).map((c) => inlineText(c).replace(/\s+/g, ' ').trim())
          if (cells.some(Boolean)) lines.push('| ' + cells.join(' | ') + ' |')
          if (lines.length >= 200) break
        }
        if (lines.length) push('\n' + lines.join('\n') + '\n')
        return
      }
      if (tag === 'LI') {
        if (hasBlockChild(el)) {
          push('\n- ')
          for (const c of el.childNodes) {
            if (c.nodeType === 3) {
              const t = c.nodeValue.replace(/\s+/g, ' ').trim()
              if (t) push(t + ' ')
            } else if (c.nodeType === 1) visit(c)
          }
        } else {
          const t = inlineText(el).replace(/\s+/g, ' ').trim()
          if (t) push('\n- ' + t)
        }
        return
      }
      if (tag === 'HR') return push('\n---\n')
      if (tag === 'IMG') {
        const alt = el.getAttribute('alt')
        if (alt && alt.trim()) push('[image: ' + clip(alt, 80) + ']')
        return
      }
      if (hasBlockChild(el) || el.shadowRoot) {
        if (el.shadowRoot) for (const c of el.shadowRoot.children) visit(c)
        for (const c of el.childNodes) {
          if (c.nodeType === 3) {
            const t = c.nodeValue.replace(/\s+/g, ' ').trim()
            if (t) push(t + ' ')
          } else if (c.nodeType === 1) visit(c)
        }
        if (BLOCK.test(tag)) push('\n')
        return
      }
      const t = inlineText(el).replace(/[ \t]+/g, ' ').trim()
      if (t) push(BLOCK.test(tag) ? '\n' + t + '\n' : t + ' ')
    }
    visit(root)
    return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  function read(opts = {}) {
    const root = opts.scope ? elementOf(opts.scope) : opts.full ? document.body : pickMain()
    if (!root) return { ok: false, error: opts.scope ? 'scope element is gone' : 'no document body' }
    let text = toMarkdown(root, !!opts.full || !!opts.scope)
    const total = text.length
    let matches
    if (opts.grep) {
      let re
      try {
        re = new RegExp(opts.grep, 'i')
      } catch {
        re = new RegExp(String(opts.grep).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      }
      const lines = text.split('\n')
      const keep = new Set()
      lines.forEach((line, i) => {
        if (re.test(line)) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) keep.add(j)
      })
      matches = lines.filter((line) => re.test(line)).length
      const picked = []
      let last = -2
      for (const i of Array.from(keep).sort((a, b) => a - b)) {
        if (i > last + 1 && picked.length) picked.push('…')
        picked.push(lines[i])
        last = i
      }
      text = picked.join('\n')
    }
    const offset = Math.max(0, opts.offset || 0)
    const max = opts.maxChars || 12000
    const slice = text.slice(offset, offset + max)
    return { ok: true, url: location.href, title: document.title, text: slice, total, shown: slice.length, offset, more: offset + slice.length < text.length, matches }
  }

  function find(query, limit = 12) {
    const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean)
    const nodes = collect().nodes.filter((n) => n.k === 'e')
    const scored = []
    for (const n of nodes) {
      const hay = (n.role + ' ' + n.name + ' ' + (n.value ?? '') + ' ' + (n.href ?? '') + ' ' + n.tag + ' ' + (n.type ?? '')).toLowerCase()
      let score = 0
      for (const t of tokens) if (hay.includes(t)) score += n.name.toLowerCase().includes(t) ? 2 : 1
      if (score >= Math.max(1, tokens.length)) scored.push({ score: score + (n.inView ? 0.5 : 0), n })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((s) => s.n)
  }

  // ---- stable descriptions for saved routines -------------------------------------

  function cssPath(el) {
    const parts = []
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id) && !/\d{4,}/.test(n.id)) {
        parts.unshift('#' + n.id)
        break
      }
      const tag = n.tagName.toLowerCase()
      const parent = n.parentElement
      if (!parent) {
        parts.unshift(tag)
        break
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName)
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : tag)
    }
    return parts.join(' > ')
  }

  function describe(id) {
    const el = elementOf(id)
    if (!el) return null
    return {
      role: roleOf(el),
      name: clip(nameOf(el), 90),
      tag: el.tagName.toLowerCase(),
      type: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined,
      href: el.tagName === 'A' ? shortHref(el) : undefined,
      testid: el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined,
      htmlId: el.id || undefined,
      nameAttr: el.getAttribute('name') || undefined,
      path: cssPath(el),
    }
  }

  /** Find the element a saved description refers to. Returns { id, score, ambiguous } or null. */
  function locate(fp) {
    const nodes = collect().nodes.filter((n) => n.k === 'e')
    let best = null
    let second = 0
    for (const n of nodes) {
      const el = elementOf(n.id)
      if (!el) continue
      let score = 0
      if (fp.testid && (el.getAttribute('data-testid') || el.getAttribute('data-test')) === fp.testid) score += 6
      if (fp.htmlId && el.id === fp.htmlId) score += 5
      if (fp.nameAttr && el.getAttribute('name') === fp.nameAttr) score += 4
      if (n.role === fp.role) score += 2
      if (n.tag === fp.tag) score += 1
      if (fp.type && n.type === fp.type) score += 1
      if (fp.name) {
        const a = n.name.toLowerCase()
        const b = fp.name.toLowerCase()
        if (a === b) score += 5
        else if (a && (a.includes(b) || b.includes(a))) score += 2
      }
      if (fp.href && n.href === fp.href) score += 3
      if (fp.path && cssPath(el) === fp.path) score += 3
      if (!best || score > best.score) {
        second = best ? best.score : 0
        best = { id: n.id, score }
      } else if (score > second) second = score
    }
    if (!best || best.score < 6) return null
    return { id: best.id, score: best.score, ambiguous: second >= best.score - 1 }
  }

  function scrollTo(where) {
    const max = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
    window.scrollTo({ top: where === 'top' ? 0 : max, behavior: 'instant' })
    return { ok: true }
  }

  globalThis.__brewse = { snapshot, resolve, setSelect, setValue, prepareType, waitQuiet, expect, read, find, describe, locate, scrollTo, ready: () => document.readyState, docId: () => docId }
})()
