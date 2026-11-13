interface KeyDef {
  key: string
  code: string
  keyCode: number
  text?: string
}

const NAMED: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}

const MODIFIERS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, mod: 4, shift: 8 }

export interface ParsedKey extends KeyDef {
  modifiers: number
}

/** Parse "Enter", "Escape", "a" or a chord like "Meta+A" / "Shift+Tab". */
export function parseKey(spec: string): ParsedKey | null {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return null
  let modifiers = 0
  const name = parts.pop()!
  for (const p of parts) {
    const bit = MODIFIERS[p.toLowerCase()]
    if (!bit) return null
    modifiers |= bit
  }
  const named = NAMED[name.toLowerCase()]
  if (named) return { ...named, modifiers }
  if (name.length === 1) {
    const upper = name.toUpperCase()
    const isLetter = upper >= 'A' && upper <= 'Z'
    const isDigit = name >= '0' && name <= '9'
    return {
      key: modifiers & 8 ? upper : name,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      // A chord with Meta/Ctrl/Alt is a shortcut, not text input.
      text: modifiers & 7 ? undefined : name,
      modifiers,
    }
  }
  return null
}
