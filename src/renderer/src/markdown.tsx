import { For, createMemo, type JSX } from 'solid-js'

// Markdown renderer for agent output. It builds elements directly (never
// innerHTML), so page text quoted by the agent cannot inject markup, and it
// splits the text into blocks so that while text streams in only the last
// block re-renders.

interface ListNode {
  ordered: boolean
  items: { text: string; checked?: boolean; children: ListNode[] }[]
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'code'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'hr' }
  | { type: 'list'; list: ListNode }
  | { type: 'table'; head: string[]; rows: string[][] }

const FENCE = /^\s*```/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

function parseList(lines: string[], start: number): { list: ListNode; next: number } {
  const flat: { indent: number; ordered: boolean; text: string; checked?: boolean }[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    const m = LIST.exec(line)
    if (m) {
      let text = m[3]
      let checked: boolean | undefined
      const task = /^\[( |x|X)\]\s+/.exec(text)
      if (task) {
        checked = task[1] !== ' '
        text = text.slice(task[0].length)
      }
      flat.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text, checked })
      i++
    } else if (!line.trim()) {
      // A blank line ends the list unless another item follows it.
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      if (j < lines.length && LIST.test(lines[j])) i = j
      else break
    } else if (/^\s+\S/.test(line) && flat.length) {
      flat[flat.length - 1].text += ` ${line.trim()}`
      i++
    } else break
  }

  const root: ListNode = { ordered: flat[0].ordered, items: [] }
  const stack = [{ indent: flat[0].indent, node: root }]
  for (const item of flat) {
    while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) stack.pop()
    let top = stack[stack.length - 1]
    if (item.indent > top.indent && top.node.items.length) {
      const child: ListNode = { ordered: item.ordered, items: [] }
      top.node.items[top.node.items.length - 1].children.push(child)
      top = { indent: item.indent, node: child }
      stack.push(top)
    }
    top.node.items.push({ text: item.text, checked: item.checked, children: [] })
  }
  return { list: root, next: i }
}

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  const startsBlock = (line: string, next: string | undefined) =>
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST.test(line) || line.startsWith('>') || (line.includes('|') && next !== undefined && TABLE_RULE.test(next))

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    if (FENCE.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] })
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      blocks.push({ type: 'table', head, rows })
      continue
    }
    if (LIST.test(line)) {
      const { list, next } = parseList(lines, i)
      blocks.push({ type: 'list', list })
      i = next
      continue
    }
    if (line.startsWith('>')) {
      const body: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push({ type: 'quote', text: body.join(' ') })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim())
    blocks.push({ type: 'p', text: para.join(' ') })
  }
  return blocks
}

// code | [label](url) | bare url | **bold** | __bold__ | ~~strike~~ | *italic* | _italic_
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?])|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\*([^*\s][^*\n]*?)\*|(?<![\w])_([^_\s][^_\n]*?)_(?![\w])/g

function inline(text: string, onLink: (url: string) => void): JSX.Element[] {
  const out: JSX.Element[] = []
  let last = 0
  const link = (url: string, label: JSX.Element) => (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault()
        onLink(url)
      }}
    >
      {label}
    </a>
  )
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push(<code>{m[1]}</code>)
    else if (m[2] !== undefined) {
      // Only real web addresses become links; anything else is shown as its label.
      out.push(/^https?:\/\//.test(m[3]) ? link(m[3], inline(m[2], onLink)) : inline(m[2], onLink))
    } else if (m[4] !== undefined) out.push(link(m[4], m[4].replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')))
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<strong>{inline(m[5] ?? m[6], onLink)}</strong>)
    else if (m[7] !== undefined) out.push(<s>{inline(m[7], onLink)}</s>)
    else out.push(<em>{inline(m[8] ?? m[9], onLink)}</em>)
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function List(props: { list: ListNode; onLink: (url: string) => void }): JSX.Element {
  const items = () =>
    props.list.items.map((item) => (
      <li classList={{ task: item.checked !== undefined }}>
        {item.checked !== undefined && <span class="md-check" classList={{ on: item.checked }} />}
        {inline(item.text, props.onLink)}
        {item.children.map((child) => (
          <List list={child} onLink={props.onLink} />
        ))}
      </li>
    ))
  return props.list.ordered ? <ol>{items()}</ol> : <ul>{items()}</ul>
}

export function Markdown(props: { text: string; onLink: (url: string) => void }): JSX.Element {
  const blocks = createMemo(() => parseBlocks(props.text))
  return (
    <div class="md">
      <For each={blocks()}>
        {(b) => {
          switch (b.type) {
            case 'code':
              return <pre>{b.text}</pre>
            case 'h':
              return <div class={`md-h md-h${Math.min(4, b.level)}`}>{inline(b.text, props.onLink)}</div>
            case 'hr':
              return <hr />
            case 'quote':
              return <blockquote>{inline(b.text, props.onLink)}</blockquote>
            case 'list':
              return <List list={b.list} onLink={props.onLink} />
            case 'table':
              return (
                <div class="md-table">
                  <table>
                    <thead>
                      <tr>
                        {b.head.map((c) => (
                          <th>{inline(c, props.onLink)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {b.rows.map((row) => (
                        <tr>
                          {row.map((c) => (
                            <td>{inline(c, props.onLink)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            default:
              return <p>{inline(b.text, props.onLink)}</p>
          }
        }}
      </For>
    </div>
  )
}
