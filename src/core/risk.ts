import type { Action, ElNode } from './browser/types'

// Decided in code, from the control itself, never from page text: a page cannot
// argue its way past this gate.

const RISKY_BUTTON =
  /\b(buy|purchase|pay|place (your |the )?order|complete (order|purchase|booking)|confirm (order|purchase|payment|booking|transfer)|check ?out|submit (order|payment|application)|send|post|publish|tweet|reply|delete|remove|erase|discard|cancel (subscription|order|booking|membership)|unsubscribe|transfer|withdraw|book|reserve|subscribe|deactivate|close account|sign ?out|log ?out|donate|bid|apply now|accept offer|authorize|approve)\b/i
const SECRET_FIELD = /\b(password|passcode|card ?number|credit card|debit card|cvv|cvc|security code|expir|ssn|social security|routing number|account number|one[- ]time|otp|verification code)\b/i
const BENIGN_BUTTON =
  /^(next|previous|prev|back|close|cancel|dismiss|accept( all)?( cookies)?|allow all|reject( all)?|decline|got it|ok(ay)?|no thanks|not now|skip|show (more|all|less)|load more|see (more|all)|view (more|all)|read more|more|expand|collapse|menu|search|go|filter|sort|apply|open|view|details|continue reading|×|x)$/i
const REVERSIBLE_ROLES = new Set(['link', 'tab', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'checkbox', 'radio', 'switch', 'treeitem', 'slider', 'spinbutton'])

/** Why this action needs the user's approval, or null when it does not. */
export function riskOf(a: Action, el: ElNode | undefined): string | null {
  if (a.irreversible) return 'marked as irreversible'
  if (!el) return null
  const name = el.name
  if (a.op === 'type' && (el.type === 'password' || SECRET_FIELD.test(name))) return `entering a secret into "${name || el.type}"`
  if (a.op === 'click' && (el.role === 'button' || el.role === 'clickable' || el.role === 'link' || el.role === 'menuitem') && RISKY_BUTTON.test(name) && !BENIGN_BUTTON.test(name.trim())) {
    return `"${name}" may make a change that cannot be undone`
  }
  return null
}

/** Whether a step can be undone or is harmless to get wrong, which is what lets Jev take it without Claude. */
export function isReversible(a: Action, el: ElNode | undefined): boolean {
  if (!el || riskOf(a, el)) return false
  if (a.op === 'type' || a.op === 'select' || a.op === 'hover') return true
  if (a.op !== 'click') return false
  if (REVERSIBLE_ROLES.has(el.role)) return el.role !== 'link' || !!el.href
  if (el.states?.includes('collapsed') || el.states?.includes('expanded')) return true
  if (el.role !== 'button' && el.role !== 'clickable') return false
  const name = el.name.trim()
  if (BENIGN_BUTTON.test(name)) return true
  // Any other button, if it has a label and the label does not sound like it settles something.
  // One with no label could be anything, so Claude chooses those.
  return !!name && !COMMITS.test(name)
}

/** Labels of buttons that settle or change something. Not dangerous enough to ask the user about, but Claude picks them, not Jev. */
const COMMITS =
  /\b(submit|confirm|save|yes|proceed|finish|complete|done|sign ?up|register|create|update|agree|accept|place|order|enrol?l|join|upgrade|install|upload|share|invite|import|export|merge|commit|deploy|run|execute|start|stop|reset|clear|revoke|grant|allow|enable|disable|turn (on|off)|connect|disconnect|unlink|follow|unfollow|like|vote|upvote|downvote|rate|report|block|mute|archive|leave|quit|end|continue|checkout|add to (cart|bag|basket))\b/i

const CLOSES = /^(close|dismiss|×|x|✕|✖|no,? thanks?|not now|maybe later|later|skip|got it|ok(ay)?|reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|refuse( all)?|necessary( cookies)? only|only necessary( cookies)?|use necessary cookies only|accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|i accept|continue|cancel|hide|dismiss (this )?(message|banner|notice))$/i

/**
 * Whether a control is the kind that closes a notice lying over the page. Jev may
 * click one of these unasked to get at what Claude wanted underneath; nothing else.
 */
export function closesOverlay(el: ElNode): boolean {
  if (el.role !== 'button' && el.role !== 'clickable' && !(el.role === 'link' && !el.href)) return false
  const name = el.name.trim()
  // A small button with no label, inside the overlay, is almost always its close mark.
  if (!name) return el.w <= 56 && el.h <= 56
  if (RISKY_BUTTON.test(name) && !BENIGN_BUTTON.test(name)) return false
  return CLOSES.test(name) || /\b(close|dismiss)\b/i.test(name)
}
