// Client for Jev, TypeSafe AI's decision model. Jev does not generate text: it
// answers typed questions about a `state`, with probabilities, in roughly 0.2s.
// All questions in one request are answered independently and in parallel.
// API reference: https://docs.typesafe.ai/api/system-one

export type Question =
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'noul'; instructions: unknown }

export type Answer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }

export interface JevResult {
  answers: Record<string, Answer>
  ms: number
  inputTokens: number
}

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const RETRYABLE = new Set([429, 503, 529])

export class Jev {
  calls = 0
  tokens = 0
  totalMs = 0

  constructor(
    private key: string | undefined,
    // Pinned, not `jev-latest`: the gate thresholds are tuned against a specific version.
    private model = process.env['JEV_MODEL'] || 'jev-1.14.0',
  ) {}

  get available(): boolean {
    return !!this.key
  }

  /** USD spent so far at the list price of $0.042 per million input tokens (output is free). */
  get cost(): number {
    return (this.tokens / 1_000_000) * 0.042
  }

  async ask(state: unknown, questions: Record<string, Question>, timeoutMs = 6000): Promise<JevResult> {
    if (!this.key) throw new Error('JEV_API_KEY is not set')
    const body = JSON.stringify({ model: this.model, state, questions })
    const start = Date.now()
    let lastError = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 300 : 900))
      let res: Response
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        lastError = (e as Error).message
        continue
      }
      if (res.ok) {
        const json = (await res.json()) as { answers: Record<string, Answer>; usage?: { input_tokens?: number } }
        const ms = Date.now() - start
        this.calls++
        this.totalMs += ms
        this.tokens += json.usage?.input_tokens ?? 0
        return { answers: json.answers, ms, inputTokens: json.usage?.input_tokens ?? 0 }
      }
      lastError = `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`
      if (!RETRYABLE.has(res.status)) break
    }
    throw new Error(`Jev request failed: ${lastError}`)
  }
}
