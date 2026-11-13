import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { MCP_DEFAULT_PORT } from '../shared/protocol'
import type { Engine } from './engine'
import { BROWSING_INSTRUCTIONS, type ToolDef } from './tools'

/**
 * Serves the browser tools to coding agents (Claude Code and others) over MCP
 * on localhost. Each MCP session gets its own logged-out browser profile whose
 * tabs are closed when the session ends.
 */
export async function startMcpServer(engine: Engine, tools: ToolDef[], version: string): Promise<number> {
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const build = (): McpServer => {
    const server = new McpServer({ name: 'brewse', version }, { instructions: BROWSING_INSTRUCTIONS })
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.shape, annotations: { readOnlyHint: tool.readOnly, openWorldHint: true } },
        async (args: unknown, extra: { sessionId?: string }) => {
          const session = engine.open('mcp', extra.sessionId ?? 'stateless')
          try {
            const out = await tool.run(session, args)
            const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [{ type: 'text', text: out.text }]
            if (out.image) content.push({ type: 'image', ...out.image })
            return { content, isError: out.isError }
          } catch (e) {
            return { content: [{ type: 'text' as const, text: `error: ${(e as Error).message}` }], isError: true }
          }
        },
      )
    }
    return server
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, name: 'brewse', version }))
      return
    }
    // A web page must never be able to drive the browser: browsers send Origin on cross-origin requests, tools do not.
    const hostHeader = (req.headers.host ?? '').split(':')[0]
    if (req.headers.origin || (hostHeader !== '127.0.0.1' && hostHeader !== 'localhost')) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('not found')
      return
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport = sessionId ? transports.get(sessionId) : undefined
    let body: unknown
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end('invalid JSON')
        return
      }
    }
    if (!transport) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send initialize first' }, id: null }))
        return
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => void transports.set(id, created),
      })
      created.onclose = () => {
        if (created.sessionId) {
          transports.delete(created.sessionId)
          void engine.close(created.sessionId)
        }
      }
      await build().connect(created)
      transport = created
    }
    await transport.handleRequest(req, res, body)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[brewse-mcp]', e)
      if (!res.headersSent) res.writeHead(500).end('internal error')
    })
  })

  const wanted = Number(process.env['BREWSE_MCP_PORT']) || MCP_DEFAULT_PORT
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EADDRINUSE') return reject(e)
      // Another Brewse (or something else) holds the port: take any free one and publish it.
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    server.listen(wanted, '127.0.0.1', () => resolve(wanted))
  })

  // Lets the stdio launcher and other tools find a running Brewse.
  const dir = join(homedir(), '.brewse')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'endpoint.json'), JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, root: process.env['BREWSE_APP_ROOT'], pid: process.pid, started: Date.now() }))
  return port
}
