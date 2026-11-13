// Reading benchmark: when Claude reads a page with a question, does Jev hand over the part that
// holds the answer, how much of the page does it keep back, and how long does it take?
//   BREWSE_MCP_URL=http://127.0.0.1:<port>/mcp node bench/read.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// [question, pattern the returned text must contain]. null: the page does not hold the answer,
// so the right outcome is for Jev to say so.
const CASES = [
  ['https://en.wikipedia.org/wiki/Coffee', [
    ['Which country produces the most coffee?', /Brazil/],
    ['How much caffeine is in a cup of coffee?', /\d+\s*(mg|milligrams)/],
    ['Where does the word coffee come from?', /qahwa|koffie|kahve/i],
    ['What temperature should coffee be brewed at?', /°C|°F/],
    ['How is decaffeinated coffee made?', /decaffeinat/i],
    ['What is the difference between arabica and robusta?', /robusta/i],
    ['What is the capital of Australia?', null],
    ['How do I reset my router password?', null],
  ]],
  ['https://en.wikipedia.org/wiki/Espresso', [
    ['What pressure is used to brew espresso?', /\bbars?\b|atmospheres/i],
    ['Who invented the espresso machine?', /Moriondo|Bezzera/],
  ]],
  ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/reduce', [
    ['What happens when reduce is called on an empty array with no initial value?', /TypeError/],
    ['What arguments does the callback function receive?', /accumulator/i],
  ]],
  ['https://docs.python.org/3/library/functions.html', [
    ['What does zip do when strict is true and the iterables have different lengths?', /ValueError/],
    ['How does the round function handle values exactly halfway between two integers?', /even/i],
    ['What does the sep argument of print do?', /sep/],
  ]],
  ['https://www.gnu.org/licenses/gpl-3.0.en.html', [
    ['Can I charge money for distributing software under this license?', /price|charge|fee/i],
    ['What must I do if I convey the work in object code form?', /Corresponding Source/],
  ]],
  ['https://en.wikipedia.org/wiki/List_of_countries_by_GDP_(nominal)', [
    ['What is the GDP of India?', /India[^\n]*\d/],
    ['Which country has the largest economy?', /United States/],
  ]],
  ['https://github.com/electron/electron', [
    ['Which operating systems does Electron support?', /macOS|Windows|Linux/],
    ['How do I install Electron?', /npm install/],
  ]],
]

const endpoint = process.env.BREWSE_MCP_URL ?? JSON.parse(readFileSync(join(homedir(), '.brewse', 'endpoint.json'), 'utf8')).url
const client = new Client({ name: 'brewse-read-bench', version: '0.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
setTimeout(() => process.exit(2), 600_000).unref()
const tool = async (name, args) => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 })
  return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}

const rows = []
for (const [url, cases] of CASES) {
  const plain = await tool('browser_read', { url, max_chars: 200 })
  const total = Number((plain.match(/of (\d+)/) ?? [])[1] ?? 0)
  if (!total) {
    console.log(`SKIP ${url}: ${plain.split('\n')[0]}`)
    continue
  }
  console.log(`\n${url}  (${total.toLocaleString()} characters)`)
  for (const [question, want] of cases) {
    const t0 = performance.now()
    const out = await tool('browser_read', { question })
    const ms = Math.round(performance.now() - t0)
    const filtered = /Jev read all/.test(out)
    const nothing = /found nothing that bears/.test(out)
    const body = out.split('\nNot shown (')[0]
    let verdict
    if (want === null) verdict = nothing ? 'correct-nothing' : 'KEPT-IRRELEVANT'
    else if (nothing) verdict = 'MISSED (said nothing)'
    else verdict = want.test(body) ? (filtered ? 'answer-kept' : 'answer-kept (unfiltered)') : 'MISSED'
    rows.push({ verdict, ms, total, shown: out.length, filtered })
    console.log(`  ${verdict.padEnd(24)} ${String(ms).padStart(5)}ms  ${String(out.length).padStart(6)} chars to Claude  ${question}`)
  }
}

const count = (re) => rows.filter((r) => re.test(r.verdict)).length
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
const answerable = rows.filter((r) => !/nothing|IRRELEVANT/.test(r.verdict) || /MISSED/.test(r.verdict))
console.log(`\n${rows.length} questions`)
console.log(`  answer in what Claude was given: ${count(/^answer-kept/)} of ${answerable.length}`)
console.log(`  answer lost:                     ${count(/MISSED/)}`)
console.log(`  no answer on page, said so:      ${count(/correct-nothing/)} of ${count(/correct-nothing|IRRELEVANT/)}`)
console.log(`  page text handed to Claude:      ${Math.round((rows.reduce((n, r) => n + r.shown, 0) / rows.reduce((n, r) => n + r.total, 0)) * 100)}% of what the pages hold`)
console.log(`  median time per read:            ${median(rows.map((r) => r.ms))}ms`)
await client.close()
