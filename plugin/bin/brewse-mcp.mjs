#!/usr/bin/env node
// stdio launcher for coding agents. It makes sure a Brewse is running (starting a
// headless one if not), then relays MCP messages between stdin/stdout and
// Brewse's local HTTP endpoint. Register it with:
//   claude mcp add --scope user brewse -- node /path/to/Brewse/plugin/bin/brewse-mcp.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const endpointFile = join(homedir(), '.brewse', 'endpoint.json')
const log = (...a) => process.stderr.write(`[brewse-mcp] ${a.join(' ')}\n`)

/** Where Brewse is installed: BREWSE_HOME, the place it last ran from, or the repository this file sits in. */
function findRoot() {
  const candidates = [process.env.BREWSE_HOME]
  try {
    candidates.push(JSON.parse(readFileSync(endpointFile, 'utf8')).root)
  } catch {}
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
  return candidates.find((dir) => dir && existsSync(join(dir, 'out', 'main', 'index.js'))) ?? candidates[candidates.length - 1]
}
const root = findRoot()

async function alive(url) {
  try {
    const res = await fetch(url.replace(/\/mcp$/, '/health'), { signal: AbortSignal.timeout(800) })
    return res.ok
  } catch {
    return false
  }
}

function readEndpoint() {
  try {
    return JSON.parse(readFileSync(endpointFile, 'utf8')).url
  } catch {
    return null
  }
}

async function ensureRunning() {
  const known = readEndpoint()
  if (known && (await alive(known))) return known
  const electron = join(root, 'node_modules', '.bin', 'electron')
  if (!existsSync(electron) || !existsSync(join(root, 'out', 'main', 'index.js'))) {
    throw new Error(`Brewse is not built. Run "npm install && npm run build" in ${root}`)
  }
  log('starting Brewse headless')
  const child = spawn(electron, [root, '--headless'], { cwd: root, detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const url = readEndpoint()
    if (url && (await alive(url))) return url
  }
  throw new Error('Brewse did not start within 30 seconds')
}

const url = await ensureRunning()
let sessionId = null
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

async function forward(message) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message) })
  sessionId = res.headers.get('mcp-session-id') ?? sessionId
  if (res.status === 202) return
  const text = await res.text()
  if (!text) return
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('text/event-stream')) {
    for (const line of text.split('\n')) if (line.startsWith('data:')) write(JSON.parse(line.slice(5)))
  } else {
    const parsed = JSON.parse(text)
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) write(item)
  }
}

// Messages are relayed concurrently: a slow tool call must not hold up the next request.
const pending = new Set()
let initialized = Promise.resolve()
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  // Everything after `initialize` needs the session id it returns, so wait for that one reply first.
  const send = message.method === 'initialize' ? (initialized = forward(message)) : initialized.catch(() => {}).then(() => forward(message))
  const task = send
    .catch((e) => {
      log('request failed:', e.message)
      if (message.id !== undefined) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `Brewse is unreachable: ${e.message}` } })
    })
    .finally(() => pending.delete(task))
  pending.add(task)
})
rl.on('close', async () => {
  await Promise.allSettled([...pending])
  // Ending the session closes its tabs and discards its logged-out profile.
  if (sessionId) await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }).catch(() => {})
  process.exit(0)
})
