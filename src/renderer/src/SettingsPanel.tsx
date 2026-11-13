import { For, Show, createResource, createSignal, type JSX } from 'solid-js'
import { bridge, core } from './bridge'
import { setPanelView } from './store'

interface TrustRow {
  site: string
  kind: string
  shadow_n: number
  shadow_miss: number
  auto_n: number
  auto_fail: number
  granted: number
  progress: number
}
interface TrustSummary {
  rows: TrustRow[]
  jev: { available: boolean; calls: number; cost: number; avgMs: number }
}
interface AgentInfo {
  claudePath: string | null
  apiKey: boolean
  jev: boolean
}
interface Routine {
  name: string
  description: string
  runs: number
  failures: number
  every_minutes: number | null
  steps: string
}

export function SettingsPanel(): JSX.Element {
  const [info] = createResource(() => core<AgentInfo>('agent.info'))
  const [trust] = createResource(() => core<TrustSummary>('trust.summary'))
  const [routines] = createResource(() => core<Routine[]>('routines.list'))
  const [blocked, { mutate }] = createResource(() => core<string[]>('settings.get', { key: 'blocked_sites', fallback: [] }))
  const [draft, setDraft] = createSignal('')

  const save = (list: string[]) => {
    mutate(list)
    void core('settings.set', { key: 'blocked_sites', value: list })
  }
  const add = () => {
    const site = draft().trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
    if (!site || blocked()?.includes(site)) return
    save([...(blocked() ?? []), site])
    setDraft('')
  }

  return (
    <section class="panel">
      <header class="panel-head">
        <span class="panel-title">Settings</span>
        <button class="text-btn" onClick={() => setPanelView('agent')}>
          Back
        </button>
        <button class="text-btn" onClick={() => bridge.invoke('layout:set', { panel: 0 })}>
          Close
        </button>
      </header>
      <div class="transcript settings">
        <div class="set-group">
          <h3>Connections</h3>
          <div class="set-row">
            <span>Claude</span>
            <span class="set-value" classList={{ bad: !!info() && !info()!.claudePath && !info()!.apiKey }}>
              {info()?.apiKey ? 'API key' : info()?.claudePath ? 'Claude Code on this Mac' : info() ? 'Not found' : '…'}
            </span>
          </div>
          <div class="set-row">
            <span>Jev</span>
            <span class="set-value" classList={{ bad: !!trust() && !trust()!.jev.available }}>
              {trust()?.jev.available ? (trust()!.jev.calls ? `${trust()!.jev.calls} calls, ${trust()!.jev.avgMs} ms average` : 'Ready') : trust() ? 'No key set' : '…'}
            </span>
          </div>
          <p class="set-note">Keys are read from the .env file in the Brewse folder. Leave ANTHROPIC_API_KEY empty to use Claude Code's own login.</p>
        </div>

        <div class="set-group">
          <h3>Blocked sites</h3>
          <p class="set-note">The agent cannot read or act on these sites. You can still browse them yourself.</p>
          <For each={blocked() ?? []}>
            {(site) => (
              <div class="set-row">
                <span>{site}</span>
                <button class="text-btn" onClick={() => save((blocked() ?? []).filter((s) => s !== site))}>
                  Remove
                </button>
              </div>
            )}
          </For>
          <div class="set-add">
            <input placeholder="bank.example.com" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button class="text-btn on" disabled={!draft().trim()} onClick={add}>
              Block
            </button>
          </div>
        </div>

        <div class="set-group">
          <h3>Jev's record</h3>
          <p class="set-note">Jev reads pages for Claude, finds the controls Claude describes and closes notices in the way. When Claude picks a control itself, Jev is asked the same question in the background and scored. Balanced mode lets Jev take a kind of step on a site only after a long clean record there; one confirmed miss takes it back.</p>
          <Show when={(trust()?.rows.length ?? 0) > 0} fallback={<p class="set-empty">Nothing yet. This fills in as the agent works.</p>}>
            <For each={trust()!.rows.filter((r) => r.site !== '*')}>
              {(r) => (
                <div class="trust-row">
                  <div class="trust-head">
                    <span>
                      {r.site} <em>{r.kind}</em>
                    </span>
                    <span class="set-value" classList={{ ok: !!r.granted }}>
                      {r.granted ? 'Earned' : `${r.shadow_n - r.shadow_miss} of ${r.shadow_n} agreed`}
                    </span>
                  </div>
                  <div class="meter">
                    <div class="meter-fill" style={{ width: `${Math.round((r.granted ? 1 : r.progress) * 100)}%` }} />
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="set-group">
          <h3>Saved routines</h3>
          <Show when={(routines()?.length ?? 0) > 0} fallback={<p class="set-empty">None yet. After a task succeeds, ask Brewse to save it as a routine.</p>}>
            <For each={routines()!}>
              {(r) => (
                <div class="set-row">
                  <span>
                    {r.name}
                    <Show when={r.description}>
                      <em> {r.description}</em>
                    </Show>
                  </span>
                  <span class="set-value">
                    {JSON.parse(r.steps).length} steps{r.every_minutes ? `, every ${r.every_minutes} min` : ''}
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </section>
  )
}
