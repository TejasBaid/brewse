import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Load KEY=value pairs from the first .env found, without overriding variables already set. */
export function loadDotEnv(dirs: string[]): string | null {
  for (const dir of dirs) {
    const file = join(dir, '.env')
    if (!existsSync(file)) continue
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (value && process.env[key] === undefined) process.env[key] = value
    }
    return file
  }
  return null
}
