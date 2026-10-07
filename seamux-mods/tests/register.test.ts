// seamux-mods under `claude plugin test`: the engine, the filesystem and the
// clock are stubbed beneath the plugin, so these run with no deep-plan install.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const HOME = '/home/t'
const ROOT = '/work/repo'
const ENGINE = '/plugins/deep-plan'

type Check = { id: string; kind: string; name: string; status: string; note: string; at: number; recipe?: string }
type Inc = { n: number; title: string; status: string; obs: string; checks?: Check[] }

const check = (id: string, kind: string, status: string, extra: Partial<Check> = {}): Check =>
  ({ id, kind, name: id, status, note: '', at: 0, ...extra })

function row(incs: Inc[], allow: boolean) {
  return {
    slug: 'demo', root: ROOT, phase: 'implementing', rootBroken: false,
    gate: { allow, why: allow ? 'increment authorized' : 'No increment is authorized — `deep-plan go` opens the next one.' },
    progress: { total: incs.length, done: incs.filter(i => i.status === 'done').length },
    increments: incs,
  }
}

// A deep-plan engine in memory: `status --json` answers the plan as it stands,
// `go`, `done` and `obs check` move it the way the real engine would.
// Another tracked plan beside `demo`, for the tests that pick between plans.
function plan(slug: string, root: string, phase: string, touchedAt: number, owner?: { session: string; workspace: string }) {
  return {
    slug, root, phase, rootBroken: false,
    gate: { allow: false, why: 'in review' },
    progress: { total: 2, done: phase === 'done' ? 2 : 0 },
    increments: [],
    owner: owner ? { ...owner, at: touchedAt } : null,
    touchedAt,
  }
}

type WorldOpts = {
  cwd?: string; pointer?: boolean; facts?: object; askAgeMs?: number
  /** the session's cmux workspace */
  workspace?: string
  /** rows `status --json` answers after demo's; `demoOff` drops demo itself */
  extra?: object[]; demoOff?: boolean
  /** no intent-server port file; `cmux` absent from PATH */
  noPort?: boolean; noCmux?: boolean
  /** an engine older than checks: one obs verdict per increment, no checks */
  legacy?: boolean
  /** increment 2's checks, replacing the default unit + observability pair */
  checks2?: Check[]
}

function world(on: On, opts: WorldOpts = {}) {
  const incs: Inc[] = opts.legacy
    ? [
        { n: 1, title: 'first', status: 'done', obs: 'n/a' },
        { n: 2, title: 'second', status: 'pending', obs: 'pending' },
        { n: 3, title: 'third', status: 'pending', obs: 'n/a' },
      ]
    : [
        { n: 1, title: 'first', status: 'done', obs: 'pass', checks: [check('unit', 'test', 'pass', { recipe: 'unit' })] },
        { n: 2, title: 'second', status: 'pending', obs: 'pending',
          checks: opts.checks2 ?? [check('unit', 'test', 'pending', { recipe: 'unit' }), check('obs-retries', 'observability', 'pending')] },
        { n: 3, title: 'third', status: 'pending', obs: 'n/a', checks: [] },
      ]
  // The aggregate an engine with checks still reports, for older panes.
  const fold = (i: Inc) => !i.checks ? i.obs : !i.checks.length ? 'n/a'
    : i.checks.some(c => c.status === 'fail') ? 'fail' : i.checks.every(c => c.status === 'pass') ? 'pass' : 'pending'
  const calls: string[][] = []
  mock.env(on, { HOME, ...(opts.workspace ? { CMUX_WORKSPACE_ID: opts.workspace } : {}) })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.cwd', () => ({ value: opts.cwd ?? `${ROOT}/src` }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.read', (_$, e) => {
    if (e.path === `${HOME}/.claude/deep-plan/engine.json` && opts.pointer !== false)
      return { value: JSON.stringify({ root: ENGINE, version: '0.3.0' }) }
    if (e.path === `${HOME}/.cache/cmux-crew/cache-facts/sess-1.json` && opts.facts)
      return { value: JSON.stringify(opts.facts) }
    if (e.path === `${HOME}/.claude/plans/asks/20261004-120000-ab12.json` && opts.askAgeMs !== undefined)
      return { value: JSON.stringify({ id: '20261004-120000-ab12', cwd: opts.cwd ?? `${ROOT}/src` }) }
    if (e.path === `${HOME}/.cache/cmux-crew/board-intent.port` && !opts.noPort) return { value: '7345\n' }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', (_$, e) => ({
    value: e.path === `${HOME}/.claude/plans/asks` && opts.askAgeMs !== undefined
      ? [{ name: '20261004-120000-ab12.json', kind: 'file', size: 10, mtimeMs: 1_000_000 - opts.askAgeMs, isLink: false }]
      : [],
  }) as never)
  // The engine's own band, beneath the plugin: an empty box keyed so a test
  // can tell it from the plugin's.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine-band' }) as RenderElement
  })
  const opened: string[] = []
  const statuses: (string | undefined)[] = []
  on('ui.open', (_$, e) => { opened.push(e.id); return { value: { isPlaced: true } } as never })
  on('ui.status', (_$, e) => { statuses.push(e.text); return { value: undefined } })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  const cmux: string[][] = []
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'cmux') {
      cmux.push(e.argv.slice(1) as string[])
      if (opts.noCmux) return { deny: 'spawn cmux ENOENT' } as never
      return { value: { exitCode: 0, stdout: 'OK urls=1', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: engineRun(e.argv) }
  })
  function engineRun(argv: readonly string[]) {
    const [, script, verb, ...rest] = argv
    calls.push(argv.slice(2) as string[])
    const okOut = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
    for (const i of incs) i.obs = fold(i)
    if (script !== `${ENGINE}/deep_plan.mjs`) return { ...okOut(''), exitCode: 127, stderr: 'wrong engine' }
    const open = () => incs.find(i => i.status === 'authorized' || i.status === 'working')
    if (verb === 'status')
      return okOut(JSON.stringify([...(opts.demoOff ? [] : [row(incs, !!open())]), ...(opts.extra ?? [])]))
    if (verb === 'go') {
      const n = incs.find(i => i.status === 'pending')
      if (n) n.status = 'authorized'
      return okOut(`go demo ${n?.n}`)
    }
    if (verb === 'done') {
      const i = incs.find(x => String(x.n) === rest[1])
      if (i && !i.checks && i.obs === 'pending')
        return { ...okOut(''), exitCode: 1, stderr: 'deep-plan: increment 2 declares an observability check and it is pending' }
      const out = (i?.checks ?? []).filter(c => c.status !== 'pass')
      if (out.length) return { ...okOut(''), exitCode: 1,
        stderr: `deep-plan: increment ${rest[1]} has ${out.length} check(s) outstanding:\n` +
          out.map(c => `  · ${c.id}  [${c.kind}] ${c.status}`).join('\n') +
          `\n\ndone refused: ${out.map(c => `${c.id} ${c.status}`).join('; ')}` }
      if (i) i.status = 'done'
      return okOut(`done demo ${rest[1]}`)
    }
    // check run: a cheap recipe passes in the foreground; an expensive one
    // (e2e) detaches and reports running; --from wait resumes past acquire.
    if (verb === 'check' && rest[0] === 'run') {
      const i = incs.find(x => String(x.n) === rest[2])
      const ids = rest.slice(3).filter(a => !a.startsWith('--') && a !== 'wait')
      const lines: string[] = []
      for (const c of (i?.checks ?? []).filter(c => c.recipe && (ids.length ? ids.includes(c.id) : c.status !== 'pass'))) {
        if (c.kind === 'e2e') {
          if (c.status === 'needs-variant' && !rest.includes('--from')) continue
          Object.assign(c, { status: 'running', note: 'running since 12:00:00Z' })
          lines.push(`🔄 ${c.id} started detached (pid 4242)`)
        } else {
          Object.assign(c, { status: 'pass', note: 'exit 0 in 1.2s' })
          lines.push(`✅ ${c.id} pass — exit 0 in 1.2s`)
        }
      }
      return okOut(lines.join('\n') || 'nothing to run')
    }
    if (verb === 'obs') return okOut('check: dashboards show the new series')
    return { ...okOut(''), exitCode: 1, stderr: `unknown verb ${verb}` }
  }
  return { incs, calls, opened, statuses, clock, toasts, cmux }
}

const DENY = 'deep-plan gate [demo]: No increment is authorized — `deep-plan go` opens the next one.\n' +
  'Ask the human, then: deep-plan go demo next'

const PANE_PROPS = { title: 'plan', isFocused: true, bodyColumns: 80, placement: 'dock' } as const

describe('seamux-mods', () => {
  test('session start registers /plan-pane and /plan-pane opens the pane', async ($, on) => {
    const w = world(on)
    const registered: string[] = []
    on('command.register', (_$, e) => { registered.push(e.name); return { value: { command: e.name } } as never })
    on('session.start', () => ({ cwd: ROOT }) as never)
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    expect(registered).toEqual(['plan-pane'])
    // The timer keeps the status entry current without anyone opening the pane.
    const before = w.calls.filter(c => c[0] === 'status').length
    await w.clock.advance(5000)
    const ticked = w.calls.filter(c => c[0] === 'status').length
    expect(ticked).toBeGreaterThan(before)
    // Nothing in the state directory moved: the next ticks skip the engine
    // until 30s have passed, then run it once regardless.
    await w.clock.advance(5000)
    expect(w.calls.filter(c => c[0] === 'status').length).toBe(ticked)
    await w.clock.advance(30000)
    expect(w.calls.filter(c => c[0] === 'status').length).toBe(ticked + 1)
    const r = await $.command.run({ command: 'plan-pane', args: '' } as never)
    expect(r.text).toBe('Plan pane opened.')
    expect(w.opened).toEqual(['plan'])
  })

  for (const surface of ['terminal', 'desktop'] as const) test(`the pane draws every increment and its buttons press the engine (${surface})`, async ($, on) => {
    {
      const w = world(on)
      await $.command.run({ command: 'plan-pane', args: '' } as never)
      const ui = await $.ui.mount({ plugin: 'seamux-mods', surface, component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
      expect((await ui.find({ key: 'inc-1' }))?.text).toMatch(/✓ 1\. first/)
      expect((await ui.find({ key: 'gate' }))?.text).toMatch(/gate shut/)
      expect(await ui.find({ key: 'done-2' })).toBeUndefined()

      await ui.press({ key: 'go' })
      expect(w.calls).toContainEqual(['go', 'demo', 'next'])
      expect((await ui.find({ key: 'inc-2' }))?.text).toMatch(/● 2\. second/)
      expect((await ui.find({ key: 'gate' }))?.text).toMatch(/gate open/)
      expect(await ui.find({ key: 'go' })).toBeUndefined()

      // Each check of an increment still to do is its own row; a finished
      // increment's checks are not drawn.
      expect((await ui.find({ key: 'check-2-unit' }))?.text).toMatch(/· unit \[test\] pending/)
      expect((await ui.find({ key: 'check-2-obs-retries' }))?.text).toMatch(/obs-retries \[observability\] pending/)
      expect(await ui.find({ key: 'check-1-unit' })).toBeUndefined()
      expect(await ui.find({ key: 'obs-2' })).toBeUndefined()

      // done is refused while checks are outstanding, and the refusal is what
      // the pane shows.
      await ui.press({ key: 'done-2' })
      expect((await ui.find({ key: 'note' }))?.text).toMatch(/2 check\(s\) outstanding/)

      // run checks runs the recipe-backed ones; the observability check is
      // recorded by hand, so it stays pending and the button stays.
      await ui.press({ key: 'run-2' })
      expect(w.calls).toContainEqual(['check', 'run', 'demo', '2'])
      expect((await ui.find({ key: 'check-2-unit' }))?.text).toMatch(/✓ unit \[test\] pass — exit 0 in 1\.2s/)
      expect((await ui.find({ key: 'note' }))?.text).toMatch(/✅ unit pass/)
      expect(await ui.find({ key: 'run-2' })).toBeUndefined()
      await ui.unmount()
    }
  })

  for (const surface of ['terminal', 'desktop'] as const) test(`a gate refusal raises the band, and \`go next\` there authorizes and clears it (${surface})`, async ($, on) => {
    {
      const w = world(on)
      on('classic.PreToolUse', () => ({ deny: DENY }))
      await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/a.txt`, old_string: 'a', new_string: 'b' } as never)

      const band = await $.ui.mount({ plugin: 'seamux-mods', surface, component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never })
      expect((await band.find({ key: 'gate-band' }))?.text).toMatch(/deep-plan gate \[demo\]: No increment is authorized/)
      await band.press({ key: 'go' })
      expect(w.calls).toContainEqual(['go', 'demo', 'next'])
      expect(w.incs[1]?.status).toBe('authorized')
      expect(await band.find({ key: 'gate-band' })).toBeUndefined()
      await band.unmount()
    }
  })

  test('a check that needs a variant shows what a person runs, and `variant ready` resumes it from the wait', async ($, on) => {
    const w = world(on, { checks2: [check('e2e', 'e2e', 'needs-variant',
      { recipe: 'preview-e2e', note: 'a person runs: scripts/open-preview.sh' })] })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui.find({ key: 'check-2-e2e' }))?.text).toMatch(/✋ e2e \[e2e\] needs-variant — a person runs: scripts\/open-preview\.sh/)
    await ui.press({ key: 'resume-2-e2e' })
    expect(w.calls).toContainEqual(['check', 'run', 'demo', '2', 'e2e', '--from', 'wait'])
    expect((await ui.find({ key: 'check-2-e2e' }))?.text).toMatch(/↻ e2e \[e2e\] running/)
    expect(await ui.find({ key: 'resume-2-e2e' })).toBeUndefined()
    // A detached run shows in the status entry while it lasts.
    expect(w.statuses.at(-1)).toMatch(/demo 1\/3 · gate shut · ↻ 1 running/)
    await ui.unmount()
  })

  test('an engine older than checks: one obs button per increment, as before', async ($, on) => {
    const w = world(on, { legacy: true })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    await ui.press({ key: 'go' })
    await ui.press({ key: 'done-2' })
    expect((await ui.find({ key: 'note' }))?.text).toMatch(/observability check/)
    expect(await ui.find({ key: 'run-2' })).toBeUndefined()
    await ui.press({ key: 'obs-2' })
    expect(w.calls).toContainEqual(['obs', 'check', 'demo', '2'])
    expect((await ui.find({ key: 'note' }))?.text).toMatch(/dashboards/)
    await ui.unmount()
  })

  test('an ordinary tool error raises no band', async ($, on) => {
    world(on)
    on('classic.PreToolUse', () => ({ deny: 'some other hook said no' }))
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/a.txt`, old_string: 'a', new_string: 'b' } as never)
    const band = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never })
    expect(await band.find({ key: 'gate-band' })).toBeUndefined()
    await band.unmount()
  })

  test('outside any plan root, the pane says no plan tracks the directory', async ($, on) => {
    world(on, { cwd: '/elsewhere' })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    let ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui.find({ key: 'empty' }))?.text).toMatch(/No deep-plan plan tracks \/elsewhere/)
    await ui.unmount()
  })

  test('a plan rooted through a symlink is found from the resolved cwd', async ($, on) => {
    // macOS: /tmp is /private/tmp, the plan was rendered as /tmp/x, and the
    // session reports the resolved cwd. The engine says what the root resolves to.
    world(on, { cwd: '/private/tmp/x/src', demoOff: true,
      extra: [{ ...plan('linked', '/tmp/x', 'implementing', 5), realRoot: '/private/tmp/x' }] })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui.find({ key: 'plan' }))?.text).toMatch(/^linked · implementing/)
    await ui.unmount()
  })

  test('a plan this session owns shows even when its root is another repo', async ($, on) => {
    world(on, { cwd: '/elsewhere', extra: [plan('far', '/other/repo', 'review', 5, { session: 'sess-1', workspace: '' })] })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui.find({ key: 'plan' }))?.text).toMatch(/^far · review/)
    await ui.unmount()
  })

  test('back to back in one workspace: the new active plan beats the finished one in this repo, and switch moves between them', async ($, on) => {
    // demo is off; `old` holds the cwd and is done; `new` is rooted elsewhere,
    // owned by this workspace from an earlier session (before a /clear).
    world(on, {
      demoOff: true, workspace: 'ws-1',
      extra: [
        plan('old', ROOT, 'done', 100, { session: 'sess-0', workspace: 'ws-1' }),
        plan('new', '/other/repo', 'review', 50, { session: 'sess-0', workspace: 'ws-1' }),
        plan('someone-elses', '/third/repo', 'review', 900, { session: 'sess-9', workspace: 'ws-9' }),
      ],
    })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui.find({ key: 'plan' }))?.text).toMatch(/^new · review/)
    expect((await ui.find({ key: 'other-old' }))?.text).toMatch(/old · done/)
    expect(await ui.find({ key: 'other-someone-elses' })).toBeUndefined()

    await ui.press({ key: 'switch-old' })
    expect((await ui.find({ key: 'plan' }))?.text).toMatch(/^old · done .* · pinned/)
    await ui.press({ key: 'unpin' })
    expect((await ui.find({ key: 'plan' }))?.text).toMatch(/^new · review/)
    await ui.unmount()
  })

  test('between two active plans the most recently touched wins', async ($, on) => {
    world(on, {
      demoOff: true, cwd: '/elsewhere',
      extra: [
        plan('earlier', '/a', 'implementing', 10, { session: 'sess-1', workspace: '' }),
        plan('later', '/b', 'review', 20, { session: 'sess-1', workspace: '' }),
      ],
    })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui.find({ key: 'plan' }))?.text).toMatch(/^later/)
    await ui.unmount()
  })

  test('/plan-pane <slug> pins that plan; an unknown slug falls back to the automatic pick', async ($, on) => {
    world(on, { extra: [plan('far', '/other/repo', 'review', 5)] })
    const r = await $.command.run({ command: 'plan-pane', args: ' far ' } as never)
    expect(r.text).toBe('Plan pane opened, pinned to far.')
    const ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui.find({ key: 'plan' }))?.text).toMatch(/^far · review .* · pinned/)
    await ui.unmount()

    const miss = await $.command.run({ command: 'plan-pane', args: 'nope' } as never)
    expect(miss.text).toMatch(/No tracked deep-plan plan is named nope/)
    const ui2 = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui2.find({ key: 'plan' }))?.text).toMatch(/^demo · implementing/)
    await ui2.unmount()
  })

  test('the pane links back to the review while in review, and `open review` opens it in cmux', async ($, on) => {
    const w = world(on, { demoOff: true, cwd: '/elsewhere', extra: [plan('far', '/other/repo', 'review', 5, { session: 'sess-1', workspace: '' })] })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui.find({ key: 'link' }))?.text).toMatch(/http:\/\/127\.0\.0\.1:7345\/plan\/far\.review\.html/)
    expect((await ui.find({ key: 'open' }))?.text).toMatch(/open review/)
    await ui.press({ key: 'open' })
    expect(w.cmux).toEqual([['open', 'http://127.0.0.1:7345/plan/far.review.html']])
    expect((await ui.find({ key: 'note' }))?.text).toMatch(/opened http/)
    await ui.unmount()
  })

  test('past review the link is the working tracker; with no server it is the file, and no cmux means a toast', async ($, on) => {
    const w = world(on, { noPort: true, noCmux: true })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui.find({ key: 'link' }))?.text).toMatch(/file:\/\/\/home\/t\/\.claude\/plans\/demo\.working\.html/)
    expect((await ui.find({ key: 'open' }))?.text).toMatch(/open plan/)
    await ui.press({ key: 'open' })
    expect(w.toasts).toContain('Plan page: file:///home/t/.claude/plans/demo.working.html')
    await ui.unmount()
  })

  test('no engine pointer: the pane names the missing file', async ($, on) => {
    world(on, { pointer: false })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'seamux-mods', surface: 'terminal', component: 'Pane', requestId: 'plan', props: PANE_PROPS as never })
    expect((await ui.find({ key: 'empty' }))?.text).toMatch(/engine\.json is missing/)
    await ui.unmount()
  })

  for (const [age, shown] of [[10_000, true], [120_000, false]] as const) test(`an ask page ${age / 1000}s old ${shown ? 'is' : 'is not'} toasted when AskUserQuestion runs`, async ($, on) => {
    const w = world(on, { askAgeMs: age })
    on('tool.call', () => ({ result: { answers: {} } }) as never)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    const toast = w.toasts.find(t => t.startsWith('Ask page:'))
    if (shown) expect(toast).toBe('Ask page: http://127.0.0.1:7345/ask/20261004-120000-ab12')
    else expect(toast).toBeUndefined()
  })

  test('the status entry carries the plan and the cache clock', async ($, on) => {
    const w = world(on, { facts: { staleAt: (1_000_000 + 42 * 60_000) / 1000 } })
    await $.command.run({ command: 'plan-pane', args: '' } as never)
    expect(w.statuses.at(-1)).toBe('demo 1/3 · gate shut · cache 42m')
  })
})
