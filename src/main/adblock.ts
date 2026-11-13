import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import type { Session } from 'electron'

let enginePromise: Promise<ElectronBlocker | null> | null = null
let cosmeticsClaimed = false

/** Load the blocking engine once: from the on-disk cache if present, otherwise download the lists. */
function engine(userData: string): Promise<ElectronBlocker | null> {
  if (enginePromise) return enginePromise
  const cache = join(userData, 'adblock-engine.bin')
  enginePromise = (async () => {
    try {
      if (existsSync(cache)) return ElectronBlocker.deserialize(new Uint8Array(readFileSync(cache)))
      const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch)
      writeFileSync(cache, blocker.serialize())
      return blocker
    } catch (e) {
      console.error('[brewse] ad blocking unavailable:', (e as Error).message)
      return null
    }
  })()
  return enginePromise
}

export function installAdblock(ses: Session, _profile: string, userData: string): void {
  if (process.env['BREWSE_ADBLOCK'] === '0') return
  void engine(userData).then((blocker) => {
    if (!blocker) return
    try {
      if (!cosmeticsClaimed) {
        // Full blocking, including hiding leftover ad slots, for the first profile (the user's own).
        // The library registers its page-side handlers once per process, so only one profile gets this.
        cosmeticsClaimed = true
        blocker.enableBlockingInSession(ses)
      } else {
        // Other profiles get network-level blocking, which is where the speed comes from.
        ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, blocker.onHeadersReceived)
        ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, blocker.onBeforeRequest)
      }
    } catch (e) {
      console.error('[brewse] could not enable ad blocking:', (e as Error).message)
    }
  })
}
