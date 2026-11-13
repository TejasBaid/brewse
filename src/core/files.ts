import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

// What a task may do with the files on this computer.
//
// A task reads the web, and a web page can try to give it orders. So what it
// may touch is decided here, in code, not by the model:
//   its own folder                    read and write freely
//   Desktop, Documents, Downloads     read; add new files; replacing one of yours asks first
//   anything else of yours            asks first
//   keys, passwords, app data, system never written; read only if you say so
// Commands run in a sandbox with the same shape (see `sandboxFor`).

export interface FilePolicy {
  /** This task's own folder. */
  workDir: string
  /** Where the agent's own bookkeeping lives. */
  agentDir: string
}

export type Verdict = { verdict: 'allow' } | { verdict: 'ask'; why: string } | { verdict: 'deny'; why: string }

const HOME = homedir()
/** The places you keep things, where a task may leave what you asked for. */
export const SHARED = ['Desktop', 'Documents', 'Downloads'].map((d) => join(HOME, d))

const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keychain|keychain-db)|id_(rsa|dsa|ecdsa|ed25519).*|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?|secrets?\..*|.*\.kdbx)$/i
const SECRET_DIR = /(^|\/)\.(ssh|aws|gnupg|kube|docker|config|claude)(\/|$)/

export function expand(path: string, base: string): string {
  const p = path.startsWith('~/') || path === '~' ? join(HOME, path.slice(1)) : path
  return resolve(isAbsolute(p) ? p : join(base, p))
}

/** The real location of a path, following links in whatever part of it already exists. */
function real(path: string): string {
  let existing = path
  const rest: string[] = []
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing))
    existing = dirname(existing)
  }
  try {
    return join(realpathSync(existing), ...rest)
  } catch {
    return path
  }
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
const secret = (path: string) => SECRET_NAME.test(basename(path)) || SECRET_DIR.test(path)
const tidy = (path: string) => (within(path, HOME) ? `~${path.slice(HOME.length)}` : path)

export function judgeRead(path: string, policy: FilePolicy): Verdict {
  const p = real(expand(path, policy.workDir))
  if (within(p, real(policy.workDir)) || within(p, real(policy.agentDir))) return { verdict: 'allow' }
  if (secret(p)) return { verdict: 'ask', why: `${tidy(p)} looks like it holds keys or passwords.` }
  if (SHARED.some((dir) => within(p, real(dir)))) return { verdict: 'allow' }
  if (!within(p, real(HOME))) return { verdict: 'allow' }
  if (within(p, join(real(HOME), 'Library'))) return { verdict: 'ask', why: `${tidy(p)} is application data.` }
  return { verdict: 'ask', why: `${tidy(p)} is outside this task's folder.` }
}

/** `mine` holds the files this task has already made: those it may replace without asking. */
export function judgeWrite(path: string, policy: FilePolicy, mine: Set<string>): Verdict {
  const p = real(expand(path, policy.workDir))
  if (within(p, real(policy.workDir))) return { verdict: 'allow' }
  if (secret(p)) return { verdict: 'deny', why: `${tidy(p)} holds keys or settings a task must not change.` }
  const home = real(HOME)
  if (!within(p, home)) return { verdict: 'deny', why: `${tidy(p)} is outside your own files.` }
  const relative = p.slice(home.length + 1)
  if (relative.startsWith('.') || relative.startsWith(`Library${sep}`) || relative === 'Library') return { verdict: 'deny', why: `${tidy(p)} is settings or application data, which a task must not change.` }
  if (SHARED.some((dir) => within(p, real(dir)))) {
    if (!existsSync(p) || mine.has(p)) return { verdict: 'allow' }
    return { verdict: 'ask', why: `${tidy(p)} already exists and would be replaced.` }
  }
  return { verdict: 'ask', why: `${tidy(p)} is outside this task's folder.` }
}

/** The path a tool call wants, wherever the tool keeps it. */
export function pathOf(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'notebook_path']) if (typeof input[key] === 'string') return input[key] as string
  return undefined
}

export const resolved = (path: string, policy: FilePolicy) => real(expand(path, policy.workDir))
export const shown = tidy

/**
 * The sandbox every command runs in. It can write only in the task's folder.
 * It cannot read your home folder except the task's folder, the places you
 * keep things, and where programming tools are installed. It can reach package
 * registries and nothing else on the network; the web is the browser's job.
 */
export function sandboxFor(policy: FilePolicy) {
  const tools = ['.nvm', '.pyenv', '.volta', '.bun', '.cargo', '.rustup', '.local/bin', '.local/lib', '.npm', '.cache', 'Library/Python', 'Library/Caches/pip', 'Library/Caches/Homebrew', 'Library/pnpm'].map((d) => join(HOME, d))
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [policy.workDir],
      denyRead: [HOME],
      allowRead: [policy.workDir, policy.agentDir, ...SHARED, ...tools.filter((d) => existsSync(d))],
    },
    network: {
      strictAllowlist: true,
      allowedDomains: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'github.com', '*.githubusercontent.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'],
    },
  }
}

/** A name for a task's folder: its first words, and enough of its id to be unique. */
export function folderName(title: string, id: string): string {
  const words = title
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(' ')
  return `${words || 'Task'} ${id.slice(0, 4)}`
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** Remove a task's folder if nothing was ever put in it. */
export function dropIfEmpty(dir: string): void {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
  } catch {}
}

export interface MadeFile {
  path: string
  name: string
  size: number
}

/** What a task has made: the files in its folder, plus any it put elsewhere. */
export function listMade(dir: string, elsewhere: Iterable<string>, limit = 40): MadeFile[] {
  const out: MadeFile[] = []
  const add = (path: string) => {
    try {
      const stat = statSync(path)
      if (stat.isFile() && !out.some((f) => f.path === path)) out.push({ path, name: basename(path), size: stat.size })
    } catch {}
  }
  for (const path of elsewhere) if (!within(path, dir)) add(path)
  const walk = (folder: string, depth: number) => {
    if (depth > 3 || out.length >= limit) return
    let entries: string[] = []
    try {
      entries = readdirSync(folder)
    } catch {
      return
    }
    for (const name of entries.sort()) {
      if (out.length >= limit) return
      if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__' || name === 'venv') continue
      const path = join(folder, name)
      try {
        if (statSync(path).isDirectory()) walk(path, depth + 1)
        else add(path)
      } catch {}
    }
  }
  walk(dir, 0)
  return out.slice(0, limit)
}
