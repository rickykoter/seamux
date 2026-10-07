// seamux-mods: deep-plan, drawn inside the terminal.
//
//   /plan-pane        a pane with this session's plan: each increment with its
//                     checks, go / done / run checks as buttons, a link and an `open` button
//                     back to the plan's page, plus the other plans it could
//                     be with a switch. `/plan-pane <slug>` pins one. Not /plan:
//                     that is a built-in, and the engine refuses the name.
//   the gate band     when the classic gate (deep-plan's PreToolUse hook)
//                     refuses an edit, a band above the prompt offers `go next`
//   the status entry  the plan's gate state and the prompt cache's clock
//   the ask toast     the page `deep-plan ask` opened, when AskUserQuestion
//                     follows it
//
// Nothing here decides anything. The classic gate stays the authority: the band
// only ever reacts to its refusal, and every button runs the deep-plan engine
// (found through ~/.claude/deep-plan/engine.json, as every out-of-session caller
// finds it) exactly as a person typing the command would.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SeamuxDenial, SeamuxPlan, SeamuxView } from '../types'

const PANE = 'plan'
const COMMAND = 'plan-pane'
const view = atom({ plugin: 'seamux-mods', key: 'view' } as const, null)
const denied = atom({ plugin: 'seamux-mods', key: 'denied' } as const, null)
const note = atom({ plugin: 'seamux-mods', key: 'note' } as const, '')
const pinned = atom({ plugin: 'seamux-mods', key: 'pinned' } as const, '')

// How many other candidate plans the pane lists under the one it shows.
const OTHERS_SHOWN = 5

// The classic gate's refusal opens with exactly this (deep-plan/hooks/decide.mjs
// pins it, deep-plan/probe.mjs asserts it). In a session the tool result reads
// `PreToolUse:Edit hook error: [bash ".../gate.sh"]: deep-plan gate [slug]: why`.
const DENIAL = /deep-plan gate \[([^\]\s]+)\]: ([^\n]*)/

const GLYPH: Record<string, string> = {
  done: '✓', working: '▶', authorized: '●', blocked: '✗', pending: '·',
}

const CHECK_GLYPH: Record<string, string> = {
  pass: '✓', fail: '✗', pending: '·', running: '↻', 'needs-variant': '✋',
}

// `check run` runs cheap recipes in the foreground, so a button that presses
// it waits on a test suite; expensive ones detach and return at once.
const CHECK_RUN_MS = 600000

// ---------------------------------------------------------------- engine

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

// $DEEP_PLAN_ENGINE, then the pointer the deep-plan plugin writes at every
// session start and every run. No pointer means deep-plan has not run yet on
// this machine: the pane says so rather than guessing a path.
async function engineRoot($: EngineInterface): Promise<string> {
  const forced = await $.env.get('DEEP_PLAN_ENGINE')
  if (forced) return forced
  const h = await home($)
  if (!h) return ''
  try {
    const ptr = JSON.parse(String(await $.fs.read(`${h}/.claude/deep-plan/engine.json`)))
    return typeof ptr.root === 'string' ? ptr.root : ''
  } catch {
    return ''
  }
}

type Ran = { ok: boolean; out: string }

async function engine($: EngineInterface, args: string[], timeoutMs = 20000): Promise<Ran> {
  const root = await engineRoot($)
  if (!root) return { ok: false, out: 'no deep-plan engine: ~/.claude/deep-plan/engine.json is missing (start a session with the deep-plan plugin, or run `deep-plan setup`)' }
  try {
    const r = await $.process.run(['node', `${root}/deep_plan.mjs`, ...args], { timeoutMs })
    const out = (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).trim()
    return { ok: r.exitCode === 0, out }
  } catch (err) {
    return { ok: false, out: `could not run the deep-plan engine at ${root}: ${String(err)}` }
  }
}

// What a person needs from a failed run: the engine's own `deep-plan: ...`
// line when it wrote one, else the error line of a crash, else the first line.
function headline(out: string): string {
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.find(l => l.startsWith('deep-plan')) ?? lines.find(l => /^\w*Error\b/.test(l)) ?? lines[0] ?? ''
}

// Which session is asking: its id, its cmux workspace, and where it stands.
type Me = { cwd: string; session: string; workspace: string }

const holds = (root: string, cwd: string) =>
  root !== '' && (cwd === root || cwd.startsWith(root.endsWith('/') ? root : root + '/'))

// deep-plan stamps the session and workspace on every write made from inside a
// session. The workspace outlives /clear, so a plan rendered before it still
// belongs to this pane.
const owns = (r: SeamuxPlan, me: Me) =>
  !!r.owner && ((me.session !== '' && r.owner.session === me.session) ||
    (me.workspace !== '' && r.owner.workspace === me.workspace))

// Candidates are the plans this session or workspace owns, wherever their root
// is, and the plans whose root holds the cwd. Active plans come before done
// ones, then the most recently touched, then the deepest root: so a plan just
// rendered for another repo beats a finished one in this repo, and the newest
// of back-to-back plans wins. A pin, while its plan is still tracked, beats all.
function pick(rows: SeamuxPlan[], me: Me, pin: string): { plan: SeamuxPlan | null; others: SeamuxPlan[] } {
  const ranked = rows.filter(r => owns(r, me) || holds(r.root, me.cwd)).sort((a, b) =>
    Number(a.phase === 'done') - Number(b.phase === 'done') ||
    (b.touchedAt ?? 0) - (a.touchedAt ?? 0) ||
    b.root.length - a.root.length)
  const plan = (pin ? rows.find(r => r.slug === pin) : undefined) ?? ranked[0] ?? null
  return { plan, others: ranked.filter(r => r.slug !== plan?.slug) }
}

// ---------------------------------------------------------------- refresh

// The state directory's listing, as a fingerprint: every transition rewrites a
// plan's file by rename, so an unchanged listing means an unchanged plan. The
// timer runs the engine (a node start, ~70ms) only when this moves, or every
// 30s regardless. Module variables: a reload starts them over, which only
// costs one extra run.
let lastPrint = ''
let lastRunAt = 0

async function stateFingerprint($: EngineInterface): Promise<string> {
  const dir = (await $.env.get('DEEP_PLAN_STATE_DIR')) || `${await home($)}/.claude/deep-plan/state`
  try {
    return (await $.fs.list(dir)).map(f => `${f.name}:${f.mtimeMs}`).sort().join('|')
  } catch {
    return ''
  }
}

// The timer's refresh: the engine only when the state moved, the cwd moved, or
// 30s passed; the status entry always, because the cache clock moves.
async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const print = `${await stateFingerprint($)}#${await $.session.cwd()}`
  if (print !== lastPrint || now - lastRunAt >= 30000) {
    lastPrint = print
    lastRunAt = now
    await refresh($)
  } else {
    const v = await read($, view)
    if (v) await status($, v)
  }
}

// Runs `deep-plan status --json`, keeps what it found, and redraws the status
// entry. Called by the timer, after every button, and after a refusal.
async function refresh($: EngineInterface): Promise<SeamuxView> {
  const me: Me = {
    cwd: await $.session.cwd(),
    session: await $.session.id(),
    workspace: (await $.env.get('CMUX_WORKSPACE_ID')) ?? '',
  }
  const ran = await engine($, ['status', '--json'])
  let next: SeamuxView = { plan: null, others: [], problem: '', cwd: me.cwd }
  if (!ran.ok) next = { ...next, problem: ran.out }
  else {
    let rows: SeamuxPlan[] | null = null
    try {
      rows = JSON.parse(ran.out) as SeamuxPlan[]
    } catch {
      next = { ...next, problem: 'deep-plan status --json did not answer JSON' }
    }
    if (rows) {
      // A pin outlives its plan only until the plan is closed.
      const pin = await read($, pinned)
      if (pin && !rows.some(r => r.slug === pin)) await update($, pinned, () => '')
      next = { ...next, ...pick(rows, me, await read($, pinned)) }
    }
  }
  await update($, view, () => next)
  // A refusal is moot once the gate lets this plan through (someone pressed go
  // on the board, or typed it).
  if (next.plan?.gate.allow) await update($, denied, () => null)
  await status($, next)
  return next
}

// `seamux-plugins 1/7 · ▶ 2 · cache 42m`. The cache clock comes from the facts
// crew's Stop hook writes through cachefacts.py; absent without crew, and then
// the entry is the plan alone.
async function status($: EngineInterface, v: SeamuxView): Promise<void> {
  const parts: string[] = []
  const p = v.plan
  if (p) {
    const open = (p.increments ?? []).find(i => i.status === 'working' || i.status === 'authorized')
    const gate = p.phase === 'review' ? 'in review' : open ? `${GLYPH[open.status]} ${open.n}` : p.gate.allow ? 'gate open' : 'gate shut'
    parts.push(`${p.slug} ${p.progress.done}/${p.progress.total} · ${gate}`)
    // Detached checks run while the session does other things; say so.
    const running = (p.increments ?? []).flatMap(i => i.checks ?? []).filter(c => c.status === 'running').length
    if (running) parts.push(`↻ ${running} running`)
  }
  const clock = await cacheClock($)
  if (clock) parts.push(clock)
  $.ui.status(parts.length ? parts.join(' · ') : undefined)
}

async function cacheClock($: EngineInterface): Promise<string> {
  const h = await home($)
  if (!h) return ''
  try {
    const id = await $.session.id()
    const facts = JSON.parse(String(await $.fs.read(`${h}/.cache/cmux-crew/cache-facts/${id}.json`)))
    const staleAt = Number(facts.staleAt) * 1000
    if (!staleAt) return ''
    const left = Math.ceil((staleAt - (await $.clock.now())) / 60000)
    return left > 0 ? `cache ${left}m` : 'cache cold'
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- actions

// Runs one engine verb for a button, keeps its answer for the pane's foot, and
// refreshes so every surface shows the new state.
async function act($: EngineInterface, args: string[], timeoutMs?: number): Promise<Ran> {
  const ran = await engine($, args, timeoutMs)
  const said = ran.ok ? ran.out.split('\n')[0] : headline(ran.out)
  await update($, note, () => `deep-plan ${args.join(' ')}: ${said || (ran.ok ? 'ok' : 'failed')}`)
  await refresh($)
  return ran
}

// Checks run by the engine, as `check run` typed would: the recipe-backed ones
// still outstanding, or one needs-variant check resumed past its acquire step
// once a person has acquired the variant.
async function runChecks($: EngineInterface, slug: string, n: number, resume?: string): Promise<void> {
  await update($, note, () => resume ? `resuming ${resume} from its wait step…` : `running increment ${n}'s checks…`)
  await act($, ['check', 'run', slug, String(n), ...(resume ? [resume, '--from', 'wait'] : [])], CHECK_RUN_MS)
}

async function goNext($: EngineInterface, slug: string): Promise<void> {
  const ran = await act($, ['go', slug, 'next'])
  if (ran.ok) {
    await update($, denied, () => null)
    $.ui.toast(`${ran.out.split("\n")[0]}. Tell Claude to carry on.`, { timeoutMs: 8000 })
  } else {
    $.ui.toast(headline(ran.out) || 'deep-plan go failed', { timeoutMs: 8000 })
  }
}

// A switch pins the pane to that plan; an empty slug goes back to the
// automatic pick.
async function switchTo($: EngineInterface, slug: string): Promise<void> {
  await update($, pinned, () => slug)
  await refresh($)
}

// Opened by a person (the command, the band's button), so it takes the keys:
// its hotkeys work at once, and Esc hands them back to the prompt.
async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'plan', focus: true })
}

async function plansDir($: EngineInterface, h: string): Promise<string> {
  return (await $.env.get('DEEP_PLAN_PLANS_DIR')) || `${h}/.claude/plans`
}

// A page as the intent server serves it at `served`, or as the file under the
// plans directory when the server is not up: the file is still a page.
async function pageUrl($: EngineInterface, h: string, served: string, file: string): Promise<string> {
  try {
    const port = String(await $.fs.read(`${h}/.cache/cmux-crew/board-intent.port`)).trim()
    if (/^\d+$/.test(port)) return `http://127.0.0.1:${port}/${served}`
  } catch {
    // no intent server
  }
  return `file://${await plansDir($, h)}/${file}`
}

// The page `deep-plan ask` opened for this cwd within the last minute.
async function askPage($: EngineInterface): Promise<string> {
  const h = await home($)
  if (!h) return ''
  const dir = await plansDir($, h)
  try {
    const asks = (await $.fs.list(`${dir}/asks`)).filter(f => f.name.endsWith('.json'))
    const newest = asks.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (!newest || (await $.clock.now()) - newest.mtimeMs > 60000) return ''
    const ask = JSON.parse(String(await $.fs.read(`${dir}/asks/${newest.name}`)))
    if (ask.cwd && ask.cwd !== (await $.session.cwd())) return ''
    const id = String(ask.id ?? newest.name.slice(0, -5))
    return await pageUrl($, h, `ask/${id}`, `asks/${id}.html`)
  } catch {
    return ''
  }
}

// The plan's page to jump back into: the review, with the alignment check,
// while the plan is in review; the working tracker after that. Re-opening the
// review once the check has passed would put the quiz back in front of the
// increments' progress.
async function planPage($: EngineInterface, p: SeamuxPlan): Promise<string> {
  const h = await home($)
  if (!h) return ''
  return p.phase === 'review'
    ? pageUrl($, h, `plan/${p.slug}.review.html`, `${p.slug}.review.html`)
    : pageUrl($, h, `plan/${p.slug}`, `${p.slug}.working.html`)
}

// Opens the page as a tab in this cmux workspace (cmux targets the caller's
// $CMUX_WORKSPACE_ID); without cmux the URL goes to a toast, and the pane's
// link stays clickable either way.
async function openPage($: EngineInterface, url: string): Promise<void> {
  try {
    const r = await $.process.run(['cmux', 'open', url], { timeoutMs: 10000 })
    if (r.exitCode === 0) {
      await update($, note, () => `opened ${url}`)
      return
    }
  } catch {
    // no cmux on PATH
  }
  $.ui.toast(`Plan page: ${url}`, { timeoutMs: 15000 })
}

// ---------------------------------------------------------------- register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Every 5s: the state can change from outside (the board's go chip, a
    // `deep-plan` typed in another terminal), and the cache clock moves.
    // Started first, so a refused command name cannot take the status entry
    // and the band's refresh down with it.
    $.clock.every(5000, () => {
      void tick($)
    })
    void refresh($)
    try {
      await $.command.register({
        name: COMMAND,
        description: "Show this session's deep-plan plan, with its checks, go, done and run checks (/plan-pane <slug> pins one)",
      })
    } catch (err) {
      $.ui.log(`seamux-mods: /${COMMAND} not registered: ${String(err)}`)
    }
    return next(e)
  })

  // `/plan-pane` goes back to the automatic pick; `/plan-pane <slug>` pins.
  on('command.run', { command: 'plan-pane' }, async ($, e) => {
    const slug = e.args.trim()
    await update($, pinned, () => slug)
    const v = await refresh($)
    await openPane($)
    if (!slug) return { text: 'Plan pane opened.' }
    if (v.plan?.slug === slug) return { text: `Plan pane opened, pinned to ${slug}.` }
    return { text: `No tracked deep-plan plan is named ${slug}; the pane shows this session's latest.` }
  })

  // React to the classic gate's refusal; never refuse anything here.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const text = ran.deny ?? (ran.isError ? ran.text : undefined)
    const hit = typeof text === 'string' ? DENIAL.exec(text) : null
    if (hit) {
      const d: SeamuxDenial = { slug: hit[1] ?? '?', why: (hit[2] ?? '').trim() }
      await update($, denied, () => d)
      void refresh($)
    }
    return ran
  })

  // The ask page opens beside the terminal (or nowhere, without cmux); the
  // dialog is in the terminal. Say where the page is before the dialog waits.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const url = await askPage($)
    if (url) $.ui.toast(`Ask page: ${url}`, { timeoutMs: 15000 })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const d = await read($, denied)
    if (e.props.hasSurvey || d === null) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box key="gate-band" flexDirection="row" gap={1} width={e.props.bodyColumns}>
        <Text color="yellow" wrap="truncate-end">
          deep-plan gate [{d.slug}]: {d.why}
        </Text>
        <Button key="go" label="go next" hotkey="g" variant="primary" onPress={() => goNext($, d.slug)} />
        <Button key="open" label="open plan" hotkey="p" onPress={() => openPane($)} />
        <Button key="dismiss" label="dismiss" hotkey="x" role="dismiss" onPress={() => update($, denied, () => null)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const last = await read($, note)
    const pin = await read($, pinned)
    const width = e.props.bodyColumns
    const p = v?.plan ?? null
    if (!p) {
      return (
        <Box key="empty" flexDirection="column" width={width}>
          <Text dimColor>{v?.problem || `No deep-plan plan tracks ${v?.cwd ?? 'this directory'}, and none belongs to this session or workspace.`}</Text>
          <Button key="refresh" label="refresh" hotkey="r" onPress={() => refresh($)} />
        </Box>
      )
    }
    const incs = p.increments ?? []
    const open = incs.find(i => i.status === 'working' || i.status === 'authorized')
    const canGo = p.phase === 'implementing' && !open && incs.some(i => i.status === 'pending')
    const page = await planPage($, p)
    const pageLabel = p.phase === 'review' ? 'open review' : 'open plan'
    return (
      <Box key="plan" flexDirection="column" width={width}>
        <Text bold wrap="truncate-end">
          {p.slug} · {p.phase} · {p.progress.done}/{p.progress.total} done{pin === p.slug ? ' · pinned' : ''}
        </Text>
        <Box key="gate">
          <Text color={p.gate.allow ? 'green' : 'yellow'} wrap="wrap">
            {p.gate.allow ? 'gate open' : 'gate shut'}: {p.gate.why}
          </Text>
        </Box>
        {p.rootBroken && <Text color="red">root is gone: the gate fails open for this plan</Text>}
        {incs.flatMap(i => {
          const live = i.status !== 'done'
          const isOpen = i.status === 'working' || i.status === 'authorized'
          // A check deep-plan can run that has not passed (and is not already running).
          const runnable = (i.checks ?? []).some(c => c.recipe && c.status !== 'pass' && c.status !== 'running')
          return [
            <Box key={`inc-${i.n}`} flexDirection="row" gap={1}>
              <Text dimColor={i.status === 'done'} wrap="truncate-end">
                {GLYPH[i.status] ?? '?'} {i.n}. {i.title}
              </Text>
              {isOpen && (
                <Button key={`done-${i.n}`} label="done" hotkey="d" onPress={() => act($, ['done', p.slug, String(i.n)])} />
              )}
              {isOpen && runnable && (
                <Button key={`run-${i.n}`} label="run checks" hotkey="c" onPress={() => runChecks($, p.slug, i.n)} />
              )}
              {/* An engine older than checks reports one observability verdict. */}
              {i.checks === undefined && i.obs !== 'n/a' && live && (
                <Button key={`obs-${i.n}`} label={`obs ${i.obs}`} dimColor onPress={() => act($, ['obs', 'check', p.slug, String(i.n)])} />
              )}
            </Box>,
            // A finished increment's checks have done their job; an open or
            // waiting one's are what stands between it and done.
            ...(live ? i.checks ?? [] : []).map(c => (
              <Box key={`check-${i.n}-${c.id}`} flexDirection="row" gap={1} marginLeft={2}>
                <Text color={c.status === 'pass' ? 'green' : c.status === 'fail' ? 'red' : c.status === 'needs-variant' ? 'yellow' : undefined}
                  dimColor={c.status === 'pending'} wrap="truncate-end">
                  {CHECK_GLYPH[c.status] ?? '?'} {c.id} [{c.kind}] {c.status}{c.note ? ` — ${c.note}` : ''}
                </Text>
                {/* The acquire step is a person's; once they have run it, this resumes from the wait. */}
                {c.status === 'needs-variant' && (
                  <Button key={`resume-${i.n}-${c.id}`} label="variant ready" onPress={() => runChecks($, p.slug, i.n, c.id)} />
                )}
              </Box>
            )),
          ]
        })}
        <Box key="actions" flexDirection="row" gap={1} marginTop={1}>
          {canGo && <Button key="go" label="go next" hotkey="g" variant="primary" onPress={() => act($, ['go', p.slug, 'next'])} />}
          {page !== '' && <Button key="open" label={pageLabel} hotkey="o" onPress={() => openPage($, page)} />}
          <Button key="refresh" label="refresh" hotkey="r" onPress={() => refresh($)} />
          {pin === p.slug && <Button key="unpin" label="unpin" onPress={() => switchTo($, '')} />}
        </Box>
        {page !== '' && (
          <Box key="link">
            <Text dimColor wrap="truncate-end">
              <Link href={page} />
            </Text>
          </Box>
        )}
        {(v?.others ?? []).length > 0 && (
          <Box key="others" flexDirection="column" marginTop={1}>
            <Text dimColor>also for this session:</Text>
            {(v?.others ?? []).slice(0, OTHERS_SHOWN).map(o => (
              <Box key={`other-${o.slug}`} flexDirection="row" gap={1}>
                <Text dimColor wrap="truncate-end">
                  {o.slug} · {o.phase} · {o.progress.done}/{o.progress.total}
                </Text>
                <Button key={`switch-${o.slug}`} label="switch" dimColor onPress={() => switchTo($, o.slug)} />
              </Box>
            ))}
          </Box>
        )}
        {last !== '' && (
          <Box key="note">
            <Text dimColor wrap="wrap">{last}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
