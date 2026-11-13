// Smoke test: connect to a running Brewse over MCP and exercise each tool on real pages.
//   npm run build && npx electron . --headless &   (then)   node bench/smoke.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const endpoint = process.env.BREWSE_MCP_URL ?? JSON.parse(readFileSync(join(homedir(), '.brewse', 'endpoint.json'), 'utf8')).url
const client = new Client({ name: 'brewse-smoke', version: '0.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))

// Never hang: give up after three minutes whatever happens.
setTimeout(() => {
  console.log('\nTIMED OUT')
  process.exit(2)
}, 180_000).unref()

const only = process.argv[2]
let failures = 0

async function call(label, name, args, check) {
  if (only && !label.includes(only)) return
  const t0 = performance.now()
  let text = ''
  let isError = false
  let image = false
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 })
    text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    image = res.content.some((c) => c.type === 'image')
    isError = !!res.isError
  } catch (e) {
    text = `THROWN: ${e.message}`
    isError = true
  }
  const ms = Math.round(performance.now() - t0)
  const pass = check ? check(text, { isError, image }) : !isError
  if (!pass) failures++
  console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${label}  (${ms}ms, ${text.length} chars${image ? ', +image' : ''})`)
  console.log(text.split('\n').slice(0, Number(process.env.LINES ?? 14)).map((l) => `    ${l.slice(0, 180)}`).join('\n'))
  return text
}

const tools = await client.listTools()
console.log(`tools: ${tools.tools.map((t) => t.name).join(', ')}`)

await call('read+grep', 'browser_read', { url: 'https://en.wikipedia.org/wiki/Coffee', grep: 'caffeine content' }, (t) => /caffeine/i.test(t))
await call('state', 'browser_state', { mode: 'viewport' }, (t) => /\[\d+\] /.test(t) && /Coffee/.test(t))
await call('find', 'browser_find', { query: 'search' }, (t) => /search/i.test(t))
await call(
  'act by target (Jev grounds)',
  'browser_act',
  { actions: [{ op: 'type', target: 'the "Search Wikipedia" search box', text: 'Espresso', enter: true, expect: [{ url: 'Espresso' }] }] },
  (t) => /ok:/.test(t) && /Espresso/.test(t),
)
await call('read after nav', 'browser_read', { max_chars: 600 }, (t) => /Espresso/.test(t))
await call('eval', 'browser_eval', { code: 'return { title: document.title, links: document.links.length }' }, (t) => /Espresso/.test(t))
await call('look', 'browser_look', { scale: 0.4 }, (_t, r) => r.image)
await call(
  'act by id with intent (shadow)',
  'browser_act',
  { actions: [{ op: 'goto', url: 'https://example.com' }] },
  (t) => /example\.com/.test(t),
)
const state = await call('state example', 'browser_state', {}, (t) => /link/.test(t))
const linkId = Number(/\[(\d+)\] link/.exec(state ?? '')?.[1])
if (linkId) {
  await call(
    'click by id',
    'browser_act',
    { actions: [{ op: 'click', id: linkId, intent: 'the "Learn more" link', expect: [{ url: 'iana.org' }] }] },
    (t) => /iana\.org/.test(t),
  )
}
// Described by meaning, so Jev has to find it: a step that cannot be undone goes back to Claude to choose.
await call('irreversible step is not grounded by Jev', 'browser_act', { actions: [{ op: 'goto', url: 'https://example.com' }, { op: 'click', target: 'the link that leads to further reading', irreversible: true }] }, (t) => /NOT DONE/.test(t) && /chosen by you/.test(t))
// Named by its exact label, so code finds it with no model: the user is still asked before it is done.
await call('irreversible step named by label still asks the user', 'browser_act', { actions: [{ op: 'click', target: 'the "Learn more" link', irreversible: true }] }, (t) => /NOT DONE/.test(t) && /needs the user's confirmation/.test(t))
const again = await call('state for risk gate', 'browser_state', {}, (t) => /link/.test(t))
const riskId = Number(/\[(\d+)\] link/.exec(again ?? '')?.[1])
await call('risk gate asks for confirmation', 'browser_act', { actions: [{ op: 'click', id: riskId, irreversible: true }] }, (t) => /NOT DONE/.test(t) && /confirmation/.test(t))
await call('expectation failure stops batch', 'browser_act', { actions: [{ op: 'goto', url: 'https://example.com', expect: [{ text: 'this text is not on the page' }] }, { op: 'scroll' }] }, (t, r) => r.isError && /DONE BUT WRONG/.test(t) && /EXPECTATION FAILED/.test(t) && /not attempted/.test(t))
await call('tabs', 'browser_tabs', { op: 'list' }, (t) => /current/.test(t))
await call('routine save', 'browser_routine', { op: 'save', name: 'smoke-example', description: 'open example.com', last_n: 1 }, (t) => /saved/.test(t))
await call('routine run', 'browser_routine', { op: 'run', name: 'smoke-example' }, (t) => /1\. ok/.test(t))
await call('routine delete', 'browser_routine', { op: 'delete', name: 'smoke-example' })

await client.close()
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`)
process.exit(failures ? 1 : 0)
