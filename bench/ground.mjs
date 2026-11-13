// Grounding benchmark: how often does Jev turn a description into the right element, and how fast?
// Each case hovers a described element (harmless) on a real page and checks which element was chosen.
//   bench/serve.sh && node bench/ground.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// want: a pattern the chosen element's line must match. want: null means no such element exists,
// so the right outcome is for Jev to decline.
const CASES = [
  ['https://en.wikipedia.org/wiki/Coffee', [
    ['the "Search Wikipedia" search box', /searchbox "Search Wikipedia"/],
    ['the Search button next to the search box', /button "Search"/],
    ['the Log in link', /link "Log in"/],
    ['the Create account link', /link "Create account"/],
    ['the link to the Talk page', /link "Talk"/],
    ['the View history link', /link "View history"/],
    ['the Donate link', /link "Donate"/],
    ['the button that opens the main menu', /button "Main menu"/],
    ['the Etymology entry in the table of contents', /link "Etymology"/],
    ['the checkout button', null],
    ['the "Add to cart" button', null],
    // Described by what the control is for, in words its label does not use.
    ['the field where I can look up another article', /searchbox/],
    ['the link for people who want to give money to Wikipedia', /link "Donate"/],
    ['the link that shows earlier versions of this article', /link "View history"/],
    ['the control that opens the side navigation', /button "Main menu"/],
  ]],
  ['https://news.ycombinator.com/', [
    ['the login link', /link "login"/],
    ['the "new" link in the top bar', /link "new"/],
    ['the submit link', /link "submit"/],
    ['the "past" link', /link "past"/],
    ['the link to show jobs', /link "jobs"/],
    ['the search field at the bottom', /textbox/],
    ['the Sign up with Google button', null],
    ['the place to sign in to my account', /link "login"/],
    ['the link for posting a story of my own', /link "submit"/],
    ['the link to the most recently posted stories', /link "new"/],
  ]],
  ['https://duckduckgo.com/', [
    ['the search box', /(searchbox|combobox|textbox)/],
    ['the settings or menu button', /(menu|settings)/i],
    ['where I type what I am looking for', /(searchbox|combobox|textbox)/],
  ]],
  ['https://developer.mozilla.org/en-US/docs/Web/JavaScript', [
    ['the search field', /(searchbox|combobox|textbox|button).*search/i],
    ['the link to the JavaScript Guide', /link.*Guide/i],
    ['the theme switcher', /(button|combobox).*(theme|color|light|dark)/i],
    ['the pay now button', null],
  ]],
  ['https://github.com/electron/electron', [
    ['the Issues tab', /link.*Issues/i],
    ['the Pull requests tab', /link.*Pull requests/i],
    ['the Code button that shows clone options', /button.*Code/i],
    ['the Sign in link', /link "Sign in"/i],
    ['the README file link in the file list', /link.*README/i],
    ['the delete repository button', null],
    ['the tab that lists reported bugs', /link.*Issues/i],
    ['the tab with proposed code changes', /link.*Pull requests/i],
    ['where I authenticate with my account', /link "Sign in"/i],
  ]],
]

const endpoint = process.env.BREWSE_MCP_URL ?? JSON.parse(readFileSync(join(homedir(), '.brewse', 'endpoint.json'), 'utf8')).url
const client = new Client({ name: 'brewse-ground-bench', version: '0.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
setTimeout(() => process.exit(2), 600_000).unref()

const tool = async (name, args) => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })
  return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}

const rows = []
for (const [url, cases] of CASES) {
  const opened = await tool('browser_act', { actions: [{ op: 'goto', url }], observe: 'none' })
  if (!/ok:/.test(opened)) {
    console.log(`SKIP ${url}: ${opened.split('\n')[0]}`)
    continue
  }
  for (const [description, want] of cases) {
    const t0 = performance.now()
    const out = await tool('browser_act', { actions: [{ op: 'hover', target: description }], observe: 'none' })
    const ms = Math.round(performance.now() - t0)
    const first = out.split('\n')[0]
    // A label quoted exactly and carried by one control is matched by code, with no model; the rest are Jev's.
    const byLabel = /matched by its label/.test(first)
    const acted = byLabel || /grounded by Jev/.test(first)
    const pick = acted ? first : (out.split('\n').find((l) => l.includes("<- Jev's pick")) ?? '')
    let verdict
    if (want === null) verdict = acted ? 'WRONG-ACT' : 'correct-decline'
    else if (acted) verdict = want.test(first) ? 'correct-act' : 'WRONG-ACT'
    else verdict = want.test(pick) ? 'declined-right-pick' : pick ? 'declined-wrong-pick' : 'declined-no-pick'
    rows.push({ url, description, verdict, ms, byLabel, detail: (acted ? first : first + ' | ' + pick.trim()).slice(0, 150) })
    console.log(`${verdict.padEnd(20)} ${String(ms).padStart(5)}ms  ${description}\n${' '.repeat(29)}${rows[rows.length - 1].detail}`)
  }
}

const count = (v) => rows.filter((r) => r.verdict === v).length
const acted = rows.filter((r) => r.verdict === 'correct-act' || r.verdict === 'WRONG-ACT')
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
console.log(`\n${rows.length} cases`)
console.log(`  acted and right:        ${count('correct-act')}   (${rows.filter((r) => r.verdict === 'correct-act' && r.byLabel).length} by exact label in code, the rest by Jev)`)
console.log(`  acted and WRONG:        ${count('WRONG-ACT')}`)
console.log(`  declined, target absent: ${count('correct-decline')}`)
console.log(`  declined, pick was right: ${count('declined-right-pick')}   (gate was too strict)`)
console.log(`  declined, pick was wrong: ${count('declined-wrong-pick') + count('declined-no-pick')}   (gate did its job)`)
console.log(`  precision when acting:  ${acted.length ? ((count('correct-act') / acted.length) * 100).toFixed(0) : '-'}%`)
console.log(`  median time per grounded action: ${median(rows.map((r) => r.ms))}ms`)
await client.close()
