import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Suggestion } from '../shared/protocol'

/** Local SQLite storage: history, the Jev scorecard and log, saved routines and settings. */
export class Store {
  readonly db: DatabaseSync
  private history: { url: string; title: string; visits: number; last: number }[] = []

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'brewse.db'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS history (url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', visits INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scorecard (
        site TEXT NOT NULL, kind TEXT NOT NULL,
        shadow_n INTEGER NOT NULL DEFAULT 0, shadow_miss INTEGER NOT NULL DEFAULT 0,
        auto_n INTEGER NOT NULL DEFAULT 0, auto_fail INTEGER NOT NULL DEFAULT 0,
        llr REAL NOT NULL DEFAULT 0, granted INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (site, kind));
      CREATE TABLE IF NOT EXISTS jev_log (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, site TEXT, kind TEXT, phase TEXT,
        options INTEGER, accepted INTEGER, margin REAL, agreement REAL, p_none REAL, p_present REAL,
        ms INTEGER, outcome TEXT);
      CREATE TABLE IF NOT EXISTS routines (
        name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', profile TEXT NOT NULL DEFAULT 'default',
        steps TEXT NOT NULL, params TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL,
        runs INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_run INTEGER,
        every_minutes INTEGER, next_run INTEGER, last_result TEXT, last_hash TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    this.history = this.db.prepare('SELECT url, title, visits, last FROM history ORDER BY last DESC LIMIT 8000').all() as never
  }

  // ---- settings ----------------------------------------------------------------

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
  }

  // ---- history and address-bar suggestions -----------------------------------------

  visit(url: string, title: string): void {
    if (!/^https?:/.test(url)) return
    const now = Date.now()
    this.db
      .prepare('INSERT INTO history (url, title, visits, last) VALUES (?, ?, 1, ?) ON CONFLICT(url) DO UPDATE SET visits = visits + 1, last = excluded.last, title = CASE WHEN excluded.title != \'\' THEN excluded.title ELSE title END')
      .run(url, title ?? '', now)
    const existing = this.history.find((h) => h.url === url)
    if (existing) {
      existing.visits++
      existing.last = now
      if (title) existing.title = title
    } else {
      this.history.unshift({ url, title: title ?? '', visits: 1, last: now })
    }
  }

  retitle(url: string, title: string): void {
    if (!title) return
    this.db.prepare('UPDATE history SET title = ? WHERE url = ?').run(title, url)
    const existing = this.history.find((h) => h.url === url)
    if (existing) existing.title = title
  }

  /** Pages worth offering on a new tab: visited often and lately, at most two from one site, no search results. */
  recent(limit = 6): Suggestion[] {
    const now = Date.now()
    const ranked = this.history
      .filter((h) => h.title && !/[?&](q|query|search)=/.test(h.url))
      .map((h) => ({ h, score: Math.min(4, Math.log2(1 + h.visits)) + Math.max(0, 3 - (now - h.last) / 86_400_000 / 5) }))
      .sort((a, b) => b.score - a.score)
    const perSite = new Map<string, number>()
    const out: Suggestion[] = []
    for (const { h } of ranked) {
      const site = siteOf(h.url)
      const seen = perSite.get(site) ?? 0
      if (seen >= 2) continue
      perSite.set(site, seen + 1)
      out.push({ kind: 'history', title: h.title, url: h.url })
      if (out.length >= limit) break
    }
    return out
  }

  /** In-memory match over history: every typed word must appear in the URL or title. */
  suggest(q: string, limit = 5): Suggestion[] {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean)
    if (!tokens.length) return []
    const now = Date.now()
    const scored: { score: number; h: { url: string; title: string; visits: number; last: number } }[] = []
    for (const h of this.history) {
      const url = h.url.toLowerCase()
      const title = h.title.toLowerCase()
      let score = 0
      let all = true
      for (const t of tokens) {
        const host = url.replace(/^https?:\/\/(www\.)?/, '')
        if (host.startsWith(t)) score += 6
        else if (url.includes(t)) score += 2
        else if (title.includes(t)) score += 1.5
        else {
          all = false
          break
        }
      }
      if (!all) continue
      const ageDays = (now - h.last) / 86_400_000
      score += Math.min(4, Math.log2(1 + h.visits)) + Math.max(0, 2 - ageDays / 7)
      // Prefer the site's front page over deep links for a short query.
      score -= Math.min(2, (h.url.split('/').length - 3) * 0.4)
      scored.push({ score, h })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(({ h }) => ({ kind: 'history', title: h.title || h.url, url: h.url }))
  }
}

export function siteOf(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    const parts = host.split('.')
    // Registrable domain, near enough for bucketing: last two labels, or three for co.uk-style suffixes.
    if (parts.length > 2 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2) return parts.slice(-3).join('.')
    return parts.slice(-2).join('.')
  } catch {
    return ''
  }
}
