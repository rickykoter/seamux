#!/usr/bin/env node
// demo — record seamux's demo videos and screenshots against a throwaway world.
//
//   node demo.mjs                  every video and screenshot, in order
//   node demo.mjs v1 v4            just these videos (each stages its own world)
//   node demo.mjs --out DIR        clips and videos (default ~/Movies/seamux-demo)
//   node demo.mjs --shots DIR      screenshots (default docs/demo/media)
//   node demo.mjs --keep           leave the world folder for a look
//
// The storyboard is ../STORYBOARD.md and every feature it covers is listed in
// ../FEATURES.md. What runs:
//
//   - ../stage.sh builds the world in DIR/.world: a git repo made from
//     ../world/shop, a bare remote, and deep-plan / lookout state of its own.
//     SEAMUX_HOST=terminal, so the plugins serve their pages on 127.0.0.1 and
//     nothing reaches your cmux, your plans or your reviews.
//   - Terminal scenes run real commands, and real Claude sessions (claude -p,
//     Sonnet) for the agent's turns, while the cast is built. Then term.html
//     plays the cast back in xterm.js and testreel films it. A beat that does
//     not happen (the gate does not refuse, a finding is not filed) fails the
//     take, so a finished take shows what the code really does.
//   - Page scenes film the shipped pages, served from the world.
//   - stitch.mjs puts each video's clips on one canvas with its cue cards.
//
// Costs a handful of short Sonnet calls per video.

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { recordPage } from 'testreel'
import { build, scrubber, finalText, toolUses, toolResults, C } from './cast.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const argv = process.argv.slice(2)
const flag = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const OUT = flag('--out', join(homedir(), 'Movies', 'seamux-demo'))
const SHOTS = flag('--shots', join(REPO, 'docs', 'demo', 'media'))
const KEEP = argv.includes('--keep')
const valued = new Set(['--out', '--shots'])
const wanted = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]))
const XTERM = pathToFileURL(join(HERE, 'node_modules', '@xterm', 'xterm')).href
const TALL = 860

// ── the world ─────────────────────────────────────────────────────────────

let W = null // { dir, env, shop, scrub }

function stage(name) {
  const dir = join(OUT, '.world', name)
  rmSync(dir, { recursive: true, force: true })
  execFileSync('bash', [join(REPO, 'docs', 'demo', 'stage.sh'), dir], { stdio: ['ignore', 'ignore', 'inherit'] })
  const raw = execFileSync('bash', ['-c', `source ${dir}/env.sh >/dev/null && env -0`])
  const env = {}
  for (const kv of raw.toString().split('\0')) {
    const i = kv.indexOf('=')
    if (i > 0 && !kv.startsWith('BASH_FUNC')) env[kv.slice(0, i)] = kv.slice(i + 1)
  }
  // Everything below runs with the world's env, like a shell that sourced env.sh.
  for (const k of Object.keys(env)) process.env[k] = env[k]
  for (const k of ['CMUX_WORKSPACE_ID', 'CMUX_SURFACE_ID', 'CMUX_SOCKET_PATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']) {
    delete process.env[k]
  }
  const real = execFileSync('bash', ['-c', `cd ${dir} && pwd -P`]).toString().trim()
  W = {
    dir: real, shop: join(real, 'shop'),
    scrub: scrubber([[join(real, 'shop'), '~/shop'], [real, '~/demo'], [REPO, '~/code/seamux']]),
  }
  return W
}

function unstage() {
  if (!W) return
  sh('node $SEAMUX/deep-plan/deep_plan.mjs serve --stop; node $SEAMUX/lookout/lookout.mjs serve --stop', { quiet: true })
  if (!KEEP) rmSync(W.dir, { recursive: true, force: true })
  W = null
}

// A shell in the world: bash with env.sh sourced, in the shop unless cwd says.
function sh(cmd, { cwd, quiet, ok = true } = {}) {
  const r = spawnSync('bash', ['-c', `source ${W.dir}/env.sh >/dev/null; ${cmd}`], {
    cwd: cwd || W.shop, encoding: 'utf8', maxBuffer: 32 << 20,
  })
  const out = (r.stdout || '') + (r.stderr || '')
  if (ok && r.status !== 0 && !quiet) throw new Error(`world command failed (${r.status}): ${cmd}\n${out}`)
  return out
}
const served = (out) => /served at (\S+)/.exec(out)?.[1]
const answers = (slug) => {
  const key = JSON.parse(readFileSync(join(W.dir, 'dp', 'keys', `${slug}.key.json`), 'utf8'))
  return Object.entries(key.answers).map(([q, a]) => `${q}=${a.letter}`).join(' ')
}
const DP = '$SEAMUX/deep-plan/deep_plan.mjs'
// Commands are filmed as a person types them; this is what really runs.
const real = (cmd) => cmd.replace(/^deep-plan /, `node ${DP} `).replace(/^lookout /, 'node $SEAMUX/lookout/lookout.mjs ')
  .replace(/^restack /, 'node $SEAMUX/restack/restack.mjs ')
const run = (cmd, o = {}) => ({ run: `source ${W.dir}/env.sh >/dev/null; ${real(o.really || cmd)}`, shown: cmd, cwd: o.cwd || W.shop, ...o })
// What the deep-plan skill tells an agent about the gate. A bare `claude -p`
// has not loaded the skill, and without this it reads "start on increment 1"
// as leave to run `deep-plan go` itself.
const RULES = 'This repo is planned with deep-plan. Only the person authorizes an increment: never run ' +
  '`deep-plan go`, `open-gate` or any --force yourself. When the gate refuses an edit, stop and say so.'
const agent = (prompt, o = {}) => ({
  agent: prompt, cwd: o.cwd || W.shop, settings: join(W.dir, 'hooks.json'), effort: 'low',
  tools: 'Read,Write,Edit,Glob,Grep,Bash', system: RULES, ...o,
})

// ── filming ───────────────────────────────────────────────────────────────

async function film(name, { viewport = { width: 1440, height: TALL }, label, prepare } = {}, body) {
  mkdirSync(join(OUT, '.raw'), { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, colorScheme: 'dark',
    recordVideo: { dir: join(OUT, '.raw'), size: viewport },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  if (prepare) await prepare(page)
  const videoStartedAt = Date.now()
  const captions = []
  const say = (text, at) => captions.push({ at: at ?? (Date.now() - videoStartedAt) / 1000, text })
  const rec = await recordPage(page, {
    videoStartedAt, name, outputDir: OUT, outputFormat: 'mp4',
    chrome: { url: label, titleBarColor: '#2b3135' }, background: false,
    cursor: { size: 40, rippleColor: 'rgba(219, 188, 127, 0.45)' },
  })
  try {
    await body({ rec, page, say, t: () => (Date.now() - videoStartedAt) / 1000 })
  } finally {
    await rec.stop().catch(() => {})
    await browser.close()
  }
  writeFileSync(join(OUT, `${name}.captions.json`), JSON.stringify(captions, null, 2) + '\n')
  console.log(`  filmed ${name} (${captions.length} cue cards)`)
}

// A terminal scene: build the cast (runs everything), then film it playing.
async function terminal(name, beats, { title = 'zsh — ~/shop', speed = 1, where = '~/shop' } = {}) {
  console.log(`  building ${name}…`)
  const cast = build(beats, { scrub: W.scrub, prompt: `${C.gn}${where}${C.r} ${C.or}❯${C.r} ` })
  writeFileSync(join(OUT, '.raw', `${name}.cast.json`), JSON.stringify(cast))
  await film(name, {
    label: title,
    prepare: async (page) => {
      await page.goto(pathToFileURL(join(HERE, 'term.html')).href + `?xterm=${encodeURIComponent(XTERM)}`)
      await page.waitForFunction(() => window.ready)
    },
  }, async ({ rec, page, say, t }) => {
    await rec.wait(600)
    const start = t()
    for (const c of cast.cues) say(c.text, start + c.at / speed)
    await page.evaluate(([c, s]) => window.play(c, s), [cast.chunks, speed])
    await rec.wait(1500)
  })
  return cast
}

// A screenshot that fails is reported, not fatal: the take goes on.
const shot = (page, file, loc) => shotOrThrow(page, file, loc).catch((e) => {
  console.log(`  shot ${file}.png FAILED: ${e.message.split('\n')[0]}`)
})
const shotOrThrow = async (page, file, loc) => {
  mkdirSync(SHOTS, { recursive: true })
  const path = join(SHOTS, `${file}.png`)
  if (loc) {
    // The element with a margin of its page around it, so text doesn't touch
    // the edge. Page coordinates, so a section taller than the window fits.
    const el = page.locator(loc).first()
    const b = await el.evaluate((e) => {
      const r = e.getBoundingClientRect()
      return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height,
        W: document.documentElement.scrollWidth, H: document.documentElement.scrollHeight }
    }, undefined, { timeout: 4000 })
    const m = 20
    const x = Math.max(0, b.x - m)
    const y = Math.max(0, b.y - m)
    await page.screenshot({ path, fullPage: true,
      clip: { x, y, width: Math.min(b.W - x, b.width + 2 * m), height: Math.min(b.H - y, b.height + 2 * m) } })
  } else await page.screenshot({ path })
  console.log(`  shot ${file}.png`)
}

// testreel's eased scroll, aimed at an element.
async function scrollTo(rec, page, sel, top = 110) {
  const y = await page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().top)
  await rec.scroll({ y: Math.round(y - top) })
}
const big = (page, k = 1.25) => page.addStyleTag({ content: `body { zoom: ${k} }` })

function stitch(names, line, to) {
  execFileSync('node', [join(HERE, 'stitch.mjs'), ...names, '--out', OUT, '--line', line, '--to', to], { stdio: 'inherit' })
}

// ── V1: one change, start to finish ──────────────────────────────────────

async function v1() {
  stage('v1')
  cpSync(join(REPO, 'docs', 'demo', 'world', 'demo-coupons.spec.json'), join(W.dir, 'demo-coupons.spec.json'))
  cpSync(join(REPO, 'docs', 'demo', 'world', 'coupon-ask.json'), join(W.dir, 'coupon-ask.json'))
  let askUrl, reviewUrl

  // 1.1 ask for a plan: the challenge and the forks, live
  await terminal('v1-ask', [
    { cue: 'Ask for a deep plan.' },
    agent('Deep plan this: take coupon codes at checkout. Use the deep-plan skill, but for now do only its ' +
      'first two steps. Question the goal: restate it, list your assumptions, and give the strongest case ' +
      'against doing it. Then list the forks you would ask me about, as a short numbered list. Do not ask ' +
      'them with AskUserQuestion, do not write files, and keep it under 170 words.',
    { shown: 'Deep plan this: take coupon codes at checkout.', tools: 'Read,Glob,Grep,Skill',
      expect: (ev) => /coupon/i.test(finalText(ev)) }),
    { cue: 'A hard choice comes with pictures.' },
    run('deep-plan ask ~/demo/coupon-ask.json', { really: `deep-plan ask ${W.dir}/coupon-ask.json`,
      filter: (t) => { askUrl = served(t); return t } }),
  ])
  if (!askUrl) throw new Error('deep-plan ask printed no URL')

  await film('v1-askpage', { label: askUrl.replace(/^http:\/\//, '') }, async ({ rec, page, say }) => {
    await page.goto(askUrl)
    await big(page)
    await page.waitForSelector('svg', { timeout: 8000 }).catch(() => {})
    say('Each option shows what it would do.')
    await rec.wait(2400)
    await shot(page, 'dp-ask')
    await rec.scroll({ y: 520 })
    await rec.wait(2600)
    say('Pick here, or answer in the terminal.')
    await rec.scroll({ y: 520 })
    await rec.wait(2600)
  })

  // 1.2 the plan renders
  await terminal('v1-render', [
    { cue: 'The plan is a page you read.' },
    run('deep-plan render ~/demo/demo-coupons.spec.json', {
      really: `deep-plan render ${W.dir}/demo-coupons.spec.json --root ${W.shop} && node ${DP} page demo-coupons --review`,
      filter: (t) => { reviewUrl = served(t); return t.split('\n').filter((l) => !/^\s*(also|spec \+ key)/.test(l)).join('\n') } }),
  ])

  await film('v1-review', { label: reviewUrl.replace(/^http:\/\//, '') }, async ({ rec, page, say }) => {
    await page.goto(reviewUrl)
    await page.waitForSelector('svg[id^="mermaid"]', { timeout: 8000 }).catch(() => {})
    say('Context, decisions, cited facts, risks.')
    await rec.wait(2600)
    await shot(page, 'dp-review')
    // a comment on a highlighted phrase
    say('Highlight a line to comment.')
    const box = await page.evaluate(() => {
      const p = [...document.querySelectorAll('#dp-main p')].find((x) => x.textContent.includes('refunds the difference'))
      const tn = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('refunds the difference'))
      const phrase = 'refunds the difference by hand'
      const i = tn.textContent.indexOf(phrase)
      const r = document.createRange(); r.setStart(tn, i); r.setEnd(tn, i + phrase.length)
      const rs = r.getClientRects(); const a = rs[0]; const z = rs[rs.length - 1]
      return { x0: a.left + 1, y0: a.top + a.height / 2, x1: z.right - 1, y1: z.top + z.height / 2 }
    })
    await page.mouse.move(box.x0, box.y0, { steps: 10 })
    await page.mouse.down()
    await page.mouse.move(box.x1, box.y1, { steps: 20 })
    await page.mouse.up()
    await rec.wait(700)
    await rec.click('#dp-hl-add')
    await rec.wait(400)
    await rec.type('.dp-quote textarea.dp-note >> nth=-1', 'How often does this happen? A number would help size it.')
    await rec.wait(1800)
    await shot(page, 'dp-comment')
    await page.mouse.click(700, 60)
    // find
    say('Press / to search the plan.')
    await page.keyboard.press('/')
    await rec.wait(400)
    await page.locator('.dp-f-opt:text("~")').click().catch(() => {})
    await rec.type('#dp-f-q', 'expird coupon')
    await rec.wait(2600)
    await shot(page, 'dp-find')
    await page.keyboard.press('Escape')
    // contracts, risks, ADRs
    await scrollTo(rec, page, 'h2:text("Contracts")')
    say('Changes to an API or a table are named.')
    await rec.wait(2600)
    await shot(page, 'dp-contracts', 'section:has(h2:text("Contracts"))')
    await scrollTo(rec, page, 'h2:text("Verified facts")')
    await shot(page, 'dp-evidence', 'section:has(h2:text("Verified facts"))')
    await scrollTo(rec, page, 'h2:text("Risks")')
    say('Decide each risk.')
    await rec.hover('.dp-risk-opt:text("spike") >> nth=0')
    await rec.wait(2600)
    await shot(page, 'dp-risks', 'section:has(h2:text("Risks"))')
    await scrollTo(rec, page, 'h2:text("ADRs")')
    say('Big decisions become ADRs.')
    await rec.click('.dp-adr-edit >> nth=0')
    await rec.wait(2600)
    await shot(page, 'dp-adr', 'section:has(h2:text("ADRs"))')
    // diagrams
    await scrollTo(rec, page, 'h2:text("Diagrams")')
    say('Each diagram starts in plain words.')
    await rec.wait(2200)
    await shot(page, 'dp-diagram', 'figure.dp-dg')
    await rec.click('.dp-dg-tabs button:text("Detailed") >> nth=0')
    await rec.wait(2200)
    // increments and checks
    await scrollTo(rec, page, 'h2:text("Increments")')
    say('Every step lists the checks it must pass.')
    await rec.wait(2800)
    await shot(page, 'dp-checks-review', 'section:has(h2:text("Increments"))')
    // the quiz
    await scrollTo(rec, page, '#dp-p-q1')
    say('A short quiz checks you agree.')
    const key = JSON.parse(readFileSync(join(W.dir, 'dp', 'keys', 'demo-coupons.key.json'), 'utf8')).answers
    for (const q of ['q1', 'q2', 'q3', 'q4']) {
      await scrollTo(rec, page, `#dp-p-${q}`, 160)
      await rec.click(`input[name="dp-q-${q}"][value="${key[q].letter}"]`)
      await rec.wait(500)
    }
    await shot(page, 'dp-quiz', '#dp-p-q1 >> xpath=..')
    await scrollTo(rec, page, '#dp-copyback', 380)
    say('Copy your answers back to the agent.')
    await rec.click('#dp-copyback', { zoom: 1.4 })
    await rec.wait(2600)
  })

  // the full-screen diagram and the narrow layout, as stills
  {
    const browser = await chromium.launch()
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
    await p.goto(reviewUrl)
    await p.waitForSelector('svg[id^="mermaid"]', { timeout: 8000 }).catch(() => {})
    const d = p.locator('figure.dp-dg').nth(1)
    await d.locator('button:text("Detailed")').click()
    await d.locator('svg').first().dblclick()
    await p.waitForTimeout(800)
    await shot(p, 'dp-diagram-full')
    await p.keyboard.press('Escape')
    await p.setViewportSize({ width: 560, height: 900 })
    await p.waitForTimeout(500)
    await shot(p, 'dp-narrow')
    await browser.close()
  }

  // 1.3–1.4 grade, the gate, go, build
  let workUrl
  await terminal('v1-gate', [
    { cue: 'The agent grades your answers.' },
    run(`deep-plan grade demo-coupons ${answers('demo-coupons')}`, { lineDelay: 0.05 }),
    { cue: 'No edits until you say go.' },
    agent('Create src/coupons/lookup.js now, with a lookup(code) function that returns null for now. Write the file first; do not check anything before.',
      { shown: 'Start on the coupon lookup.', tools: 'Write,Edit', expect: (ev) => toolResults(ev).some((r) => r.is_error && /deep-plan/.test(JSON.stringify(r.content))) }),
    { cue: 'You say go. One step opens.' },
    run('deep-plan go demo-coupons 1'),
    agent('Go ahead with increment 1 of the demo-coupons plan. Read the plan with `deep-plan status`, then ' +
      'its markdown (deep-plan prints where), write src/coupons/lookup.js and test/coupons.test.js with ' +
      'node:test, run npm test, and stop. Keep the code short; seed WELCOME10 (10% off) in the lookup module. ' +
      'Codes match without regard to case. Do not commit and do not run deep-plan done.',
    { shown: 'Go ahead with increment 1.', timeout: 420,
      expect: () => existsSync(join(W.shop, 'src', 'coupons', 'lookup.js')) }),
  ])
  workUrl = served(sh(`node ${DP} page demo-coupons`))

  // 1.5 the working page, 1.6 checks before done
  await terminal('v1-checks', [
    { cue: 'Done waits for its checks.' },
    run('deep-plan check run demo-coupons 1', { ok: false, lineDelay: 0.04 }),
    run('deep-plan done demo-coupons 1', { lineDelay: 0.04 }),
    { cue: 'You do the steps a person must.' },
    run('node scripts/metrics.mjs'),
    run('deep-plan check pass demo-coupons 1 obs-coupon-applied-counter-climbs-in-dev "coupon_applied is 14 in dev"'),
    run('echo https://pr-12.shop.test > .preview-url', { hold: 0.4 }),
    run('deep-plan check run demo-coupons 1 e2e-preview-checkout --from wait --inline', { lineDelay: 0.04 }),
    { cue: 'Commit what passed. It stays valid.' },
    run("git add -A && git commit -qm 'coupons: lookup'", { hold: 0.8 }),
    { cue: 'Change the code and the pass goes stale.' },
    run('echo "// later" >> src/coupons/lookup.js && deep-plan check list demo-coupons 1 | head -12',
      { really: `echo "// later" >> src/coupons/lookup.js && node ${DP} check list demo-coupons 1 | head -12` }),
    run('git checkout src/coupons/lookup.js && deep-plan done demo-coupons 1',
      { really: `git checkout -q src/coupons/lookup.js && node ${DP} done demo-coupons 1` }),
  ])

  await film('v1-working', { label: workUrl.replace(/^http:\/\//, '') }, async ({ rec, page, say }) => {
    await page.goto(workUrl)
    await page.waitForSelector('svg[id^="mermaid"]', { timeout: 8000 }).catch(() => {})
    say('After the quiz, the page tracks the work.')
    await scrollTo(rec, page, 'h2:text("Increments")')
    await rec.wait(3200)
    await shot(page, 'dp-working', 'section:has(h2:text("Increments"))')
  })

  // 1.7 increment 2 and its lookout review
  let review
  await terminal('v1-build2', [
    run('deep-plan go demo-coupons 2'),
    agent('Go ahead with increment 2 of the demo-coupons plan: read it with `deep-plan status` and its markdown. ' +
      'Change src/checkout/route.js so POST /checkout takes an optional coupon, looks it up with ' +
      'src/coupons/lookup.js, and passes the discount to total(). Keep it to the happy path for now: we will ' +
      'handle bad codes later, so do not add error handling for them. Add ' +
      'test/checkout.test.js. Run npm test, then commit. Do not run deep-plan done or check run.',
    { shown: 'Go ahead with increment 2.', timeout: 420,
      expect: () => /coupon/.test(readFileSync(join(W.shop, 'src', 'checkout', 'route.js'), 'utf8')) }),
    { cue: 'A fresh reviewer reads the diff.' },
    run('deep-plan check run demo-coupons 2', { ok: false, lineDelay: 0.04,
      filter: (t) => { review = /review[s]?\/([\w-]+)|lookout prompt ([\w-]+)/.exec(t); return t } }),
  ])
  const reviewId = review && (review[1] || review[2])
  if (!reviewId) throw new Error('check run printed no review id')
  await terminal('v1-reviewer', [
    agent(`You are a code reviewer. Run \`lookout prompt ${reviewId}\` and follow its brief exactly: read the ` +
      'diff, write the findings JSON it asks for, and add it with the command it names. Report how many findings ' +
      'you filed, by severity, in one line.',
    { shown: 'Review increment 2 (a fresh reviewer, briefed by lookout).', timeout: 600, tools: 'Read,Glob,Grep,Bash,Write',
      expect: () => /"severity"/.test(sh(`node $SEAMUX/lookout/lookout.mjs findings list ${reviewId} --json`, { ok: false })) }),
    run(`lookout gate ${reviewId}; echo "exit $?"`, { ok: false }),
  ])
  const reviewUrl2 = sh(`node $SEAMUX/lookout/lookout.mjs serve --url /review/${reviewId}`).trim().split('\n').pop()
  await film('v1-lookout', { label: reviewUrl2.replace(/^http:\/\//, '') }, async ({ rec, page, say }) => {
    await page.goto(reviewUrl2)
    await page.waitForSelector('.row.file', { timeout: 10000 })
    // The overview: each risky group, with a question before its note.
    await rec.click('#ov-btn')
    say('Answer first, then read the reviewer.')
    await rec.wait(2600)
    await shot(page, 'lo-quiz')
    const opt = page.locator('.ov-group button.qopt')
    if (await opt.count()) {
      await rec.click(opt.nth(1))
      await rec.wait(2600)
    }
    await shot(page, 'lo-overview')
    await rec.click('#ov-btn')
    say('Riskiest files come first.')
    await rec.click('button:text("Risk")')
    await rec.wait(2400)
    await shot(page, 'lo-risk')
    // The first file with a finding.
    const withFinding = page.locator('.row.file:has(.badge), .row.file:has([class*="sev"])').first()
    if (await withFinding.count()) await rec.click(withFinding)
    await page.locator('.threads').first().scrollIntoViewIfNeeded().catch(() => {})
    say('Findings sit on their lines.')
    await rec.wait(2800)
    await shot(page, 'lo-findings', '#main')
    await rec.click('button:text("Unified")')
    await rec.wait(1600)
    await rec.click('button:text("Split")')
    await shot(page, 'lo-diff', '#main')
    say('You close blockers, not the agent.')
    const n = await page.locator('.threads button:text("Resolve")').count()
    for (let i = 0; i < n; i++) {
      await rec.type(page.locator('.threads textarea').first(), 'Fixed in the next commit, checked by hand.').catch(() => {})
      await rec.click(page.locator('.threads button:text("Resolve")').first())
      await rec.wait(900)
    }
    await rec.wait(1800)
  })

  // 1.8 the gate opens, the last increment, then the delivery review
  let deliverUrl
  await terminal('v1-ship', [
    run(`lookout gate ${reviewId}; echo "exit $?"`, { ok: false }),
    run('deep-plan check run demo-coupons 2', { lineDelay: 0.05,
      really: `node ${DP} check wait demo-coupons 2 e2e >/dev/null; node ${DP} check run demo-coupons 2` }),
    run('deep-plan done demo-coupons 2'),
    { fn: () => {
      // Increment 3 off camera: the migration, waived checks, committed.
      sh(`node ${DP} go demo-coupons 3 >/dev/null`)
      writeFileSync(join(W.shop, 'db', 'migrate', '002_coupons.sql'),
        "CREATE TABLE coupons (\n  code TEXT PRIMARY KEY,\n  percent_off INTEGER NOT NULL,\n  expires_at TIMESTAMP\n);\nINSERT INTO coupons VALUES ('WELCOME10', 10, NULL);\n")
      sh(`git add -A && git commit -qm 'coupons: table and seed' && node ${DP} done demo-coupons 3 >/dev/null`)
    } },
    { cue: 'Ship a reviewed branch.' },
    run('deep-plan deliver demo-coupons', { ok: false, lineDelay: 0.04,
      filter: (t) => { deliverUrl = served(t); return t } }),
  ])
  if (deliverUrl) {
    await film('v1-deliver', { label: deliverUrl.replace(/^http:\/\//, '') }, async ({ rec, page, say }) => {
      await page.goto(deliverUrl)
      await page.waitForSelector('.row.file', { timeout: 10000 }).catch(() => {})
      say('One review reads every step together.')
      await rec.wait(3200)
    })
  }
}

// ── V2: one goal, several agents ──────────────────────────────────────────

async function v2() {
  stage('v2')
  execFileSync('bash', [join(REPO, 'docs', 'demo', 'world', 'family.sh'), W.dir], { stdio: ['ignore', 'ignore', 'inherit'] })
  const ui = join(W.dir, 'shop.worktrees', 'ui')
  W.scrub = scrubber([[ui, '~/shop.worktrees/ui'], [W.shop, '~/shop'], [W.dir, '~/demo'], [REPO, '~/code/seamux']])
  const parentUrl = served(sh(`node ${DP} page example-auth-revamp --review`))
  await film('v2-parent', { label: parentUrl.replace(/^http:\/\//, '') }, async ({ rec, page, say }) => {
    await page.goto(parentUrl)
    await big(page)
    await page.waitForSelector('svg[id^="mermaid"]', { timeout: 8000 }).catch(() => {})
    say('Split a big goal into workstreams.')
    await rec.wait(2400)
    await scrollTo(rec, page, 'h2:text("Workstreams")')
    say('Each one has its own plan, agent and files.')
    await rec.wait(3000)
    await shot(page, 'dp-family', 'section:has(h2:text("Workstreams"))')
    await scrollTo(rec, page, 'h2:text("What waits on what?")').catch(() => {})
    await rec.wait(2600)
  })
  const grade = (slug) => `node ${DP} grade ${slug} ${answers(slug)} >/dev/null`
  await terminal('v2-family', [
    { cue: 'A workstream waits for the parent.' },
    { fn: () => sh(grade('example-auth-ui')) },
    run('deep-plan go example-auth-ui 1', { ok: false, cwd: ui }),
    { fn: () => sh(`${grade('example-auth-revamp')} && node ${DP} go example-auth-revamp 1 >/dev/null && node ${DP} done example-auth-revamp 1 --force >/dev/null`) },
    run('deep-plan family status example-auth-revamp', { lineDelay: 0.05 }),
    run('deep-plan go example-auth-ui 1', { cwd: ui }),
    { cue: "Step on a sibling's file and you're told." },
    agent('Create the file api/auth/token.ts containing exactly: export const token = 1; Then, in one or two ' +
      'sentences, say what note you got about that file after writing it, if any.',
    { cwd: ui, shown: 'Add api/auth/token.ts with a token constant.', tools: 'Read,Write,Edit',
      expect: (ev) => /example-auth-api/.test(finalText(ev)) }),
    run('deep-plan family check example-auth-revamp', { ok: false }),
    { cue: 'Each agent hears what changed.' },
    { fn: () => sh(`${grade('example-auth-api')} && node ${DP} go example-auth-api 1 --force >/dev/null && node ${DP} done example-auth-api 1 --force >/dev/null`) },
    agent('Answering only from context you were given with this message (do not use tools): has anything ' +
      'changed in your deep-plan family? Quote the line in one sentence.',
    { cwd: ui, shown: 'Anything new from the other workstreams?', tools: 'Read',
      expect: (ev) => /finished|increment 1/i.test(finalText(ev)) }),
  ], { title: 'zsh — ~/shop.worktrees/ui', where: '~/shop.worktrees/ui' })
}

// ── V3: where it runs, and with whom ──────────────────────────────────────

async function v3() {
  stage('v3')
  cpSync(join(REPO, 'docs', 'demo', 'world', 'demo-coupons.spec.json'), join(W.dir, 'demo-coupons.spec.json'))
  sh(`node ${DP} render ${W.dir}/demo-coupons.spec.json --root ${W.shop} >/dev/null`)
  sh(`node ${DP} grade demo-coupons ${answers('demo-coupons')} >/dev/null`)
  const laptop = join(W.dir, 'laptop2')
  W.scrub = scrubber([[laptop, '~/laptop2'], [W.shop, '~/shop'], [W.dir, '~/demo'], [REPO, '~/code/seamux']])
  const other = `DEEP_PLAN_STATE_DIR=${W.dir}/l2/state DEEP_PLAN_PLANS_DIR=${W.dir}/l2/plans DEEP_PLAN_KEYS_DIR=${W.dir}/l2/keys DEEP_PLAN_SERVE_FILE=${W.dir}/l2/serve.json`
  const rows = join(W.dir, 'rows.json')
  writeFileSync(rows, JSON.stringify({ docs: [{ id: 'annotations/ra', data: { op: 'comment', file: 'src/coupons/lookup.js', line: 1, side: 'new',
    text: 'Can the seed move to the migration?', by: 'human', at: '2026-10-29T10:00:00.000Z' } }] }))
  await terminal('v3-hosts', [
    { cue: 'No cmux? It serves its own page.' },
    run('deep-plan doctor', { filter: (t) => t.split('\n').slice(0, 2).join('\n') }),
    run('deep-plan page demo-coupons'),
    { cue: 'Share a plan through git.' },
    run('deep-plan go demo-coupons 1'),
    run('deep-plan state status demo-coupons'),
    run('git ls-remote origin', { filter: (t) => t.replace(/^[0-9a-f]{40}\s+/gm, '') }),
    run('git clone -q ~/demo/remote.git ~/laptop2 && cd ~/laptop2 && deep-plan state pull demo-coupons', {
      really: `git clone -q ${W.dir}/remote.git ${laptop} && cd ${laptop} && ${other} node ${DP} state pull demo-coupons`,
      filter: (t) => t.replace(/; root .*?;/, ';') }),
    run('deep-plan status', { cwd: laptop, where: '~/laptop2', really: `${other} node ${DP} status`, filter: (t) => t.split('\n').slice(0, 2).join('\n') }),
    { cue: 'Carry it into cloud sessions.' },
    run('deep-plan install-repo && lookout install-repo && git status --short', { filter: (t) => t.replace(/ into \S*?\/(\.claude\/\S+)/g, ' into $1') }),
    { cue: 'Review from the cloud, too.' },
    { fn: () => {
      mkdirSync(join(W.shop, 'src', 'coupons'), { recursive: true })
      writeFileSync(join(W.shop, 'src', 'coupons', 'lookup.js'), "const CODES = { WELCOME10: 10 }\nexport const lookup = (c) => CODES[c.toUpperCase()] ?? null\n")
      sh('node $SEAMUX/lookout/lookout.mjs open --worktree --no-open --id coupons >/dev/null')
    } },
    run('lookout export-artifact coupons', { filter: (t) => t.replace(/exported \S+/, 'exported coupons.artifact.html') }),
    run('lookout pull coupons ~/demo/rows.json', { really: `lookout pull coupons ${rows}` }),
  ])
}

// ── V4: small tools ───────────────────────────────────────────────────────

async function v4() {
  stage('v4')
  const rsDir = join(W.dir, 'rs')
  execFileSync('bash', [join(REPO, 'docs', 'demo', 'world', 'restack-stack.sh'), rsDir], { stdio: ['ignore', 'ignore', 'inherit'] })
  const shop = join(rsDir, 'shop')
  W.scrub = scrubber([[shop, '~/shop'], [W.dir, '~/demo'], [REPO, '~/code/seamux']])
  const PUSH = ['git', 'push', '--force-with-lease'].join(' ')
  await terminal('v4-restack', [
    { cue: 'Rebase a stack. Let generated files rebuild.' },
    run('restack plan', { cwd: shop }),
    run('restack run', { cwd: shop, ok: false, expect: 2 }),
    agent("A rebase stopped on a conflict in src/tax.js. Keep the base branch's rate (0.0825) and its comment, " +
      'drop the other side, and remove the conflict markers. Edit only that file; do not run git.',
    { cwd: shop, settings: undefined, shown: "Settle the tax rate: keep main's 8.25%.", tools: 'Read,Edit,Write',
      expect: () => !/<<<<<<<|>>>>>>>/.test(readFileSync(join(shop, 'src', 'tax.js'), 'utf8')) }),
    run('git add src/tax.js && restack continue', { cwd: shop }),
    run('restack check', { cwd: shop, ok: false }),
    run('restack push', { cwd: shop }),
    { cue: 'Risky commands stop at the guard.' },
    agent(`Push both branches of this stack to origin now, with ${PUSH}. If anything stops you, say what in one sentence and stop.`,
    { cwd: shop, settings: undefined, shown: 'Just push the stack for me.', tools: 'Bash',
      expect: (ev) => toolResults(ev).some((r) => r.is_error) }),
  ])
  cpSync(join(REPO, 'docs', 'demo', 'world', 'draft-pr.md'), join(W.shop, 'PR.md'))
  W.scrub = scrubber([[W.shop, '~/shop'], [W.dir, '~/demo'], [REPO, '~/code/seamux']])
  await terminal('v4-humanize', [
    { cue: 'Make prose read like a person wrote it.' },
    run('python3 humanize/scripts/scan.py PR.md', { really: 'python3 $SEAMUX/humanize/scripts/scan.py PR.md', filter: (t) => t.split('\n').slice(0, 9).join('\n') }),
    agent('Humanize PR.md with the humanize skill, in place. Then print the new file with cat.',
    { shown: 'Humanize PR.md.', settings: undefined, tools: 'Read,Edit,Write,Skill,Bash', timeout: 400, resultLines: 14,
      expect: () => !/pivotal|seamless/.test(readFileSync(join(W.shop, 'PR.md'), 'utf8')) }),
  ])
}

// ── V5: the crew board ────────────────────────────────────────────────────

async function v5() {
  const file = execFileSync('python3', [join(REPO, 'docs', 'demo', 'board-preview.py')]).toString().trim()
  const snap = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.SNAP)))
  const push = (page, st) => page.evaluate((d) => window.__boardRender(d), st)
  await film('v5-board', { viewport: { width: 700, height: TALL }, label: 'crew · who needs you' }, async ({ rec, page, say }) => {
    await page.goto(pathToFileURL(file).href)
    await big(page, 1.45)
    await rec.wait(800)
    say('Who needs you comes first.')
    await rec.wait(2600)
    await shot(page, 'crew-board')
    say('Approve the next step from the board.')
    await rec.hover('.row[data-id="checkout-flow"] .chip.pri >> visible=true >> nth=0')
    await rec.wait(1200)
    await rec.click('.row[data-id="checkout-flow"] .chip.pri >> visible=true >> nth=0')
    const s = await snap(page)
    Object.assign(s.rows.find((r) => r.id === 'checkout-flow'), { kind: 'running', badge: 'working',
      said: '{{Coupon at capture}} in progress.', chips: ['diff', 'jump'], meta: '2/4 increments' })
    s.news.items = [{ tier: 'attend', text: '{{payments-idem}} asked you a question.' },
      { tier: 'running', text: '{{checkout-flow}} is on increment 3 of 4.' }, ...s.news.items.slice(1)]
    s.news.lede = s.news.items[0].text
    await rec.wait(700)
    await push(page, s)
    await rec.wait(2600)
    say('A family is one card.')
    await rec.click('.row.kid[data-id="billing-ledger"] >> nth=0').catch(() => {})
    await rec.wait(2600)
    await shot(page, 'crew-family', '.row[data-id="billing-revamp"]').catch(() => {})
    say('The footer says it in sentences.')
    await rec.click('#news summary')
    await rec.wait(3000)
    await shot(page, 'crew-news', '#news')
  })
  const { mockUsage } = await import('./record.mjs')
  const usageFile = (data, name) => {
    const tmpl = readFileSync(join(REPO, 'crew', 'board', 'usage.tmpl.html'), 'utf8')
    const f = join(OUT, '.raw', name)
    writeFileSync(f, tmpl.replaceAll('__DATA__', () => JSON.stringify(data)))
    return pathToFileURL(f).href
  }
  await film('v5-usage', { viewport: { width: 700, height: TALL }, label: '127.0.0.1/usage' }, async ({ rec, page, say }) => {
    await page.goto(usageFile(mockUsage(), 'usage.html'))
    await big(page, 1.35)
    say("See what you're spending.")
    await rec.wait(2600)
    await shot(page, 'crew-usage')
    await rec.scroll({ y: 520 })
    say('Dollars per workspace.')
    await rec.wait(2600)
    await rec.hover('h2:text("Cache re-writes")')
    say('Know when the cache goes cold.')
    await rec.wait(3000)
    await shot(page, 'crew-cache', 'h2:text("Cache re-writes") >> xpath=ancestor::*[count(.//*) > 12][1]')
  })
  // crew's status line under a prompt, as a still: the real statusline.py,
  // with a stub ccusage and a throwaway HOME so it reads none of yours
  {
    const d = join(OUT, '.raw', 'statusline')
    mkdirSync(join(d, 'bin'), { recursive: true })
    mkdirSync(join(d, 'home'), { recursive: true })
    writeFileSync(join(d, 'bin', 'ccusage'), '#!/bin/sh\ncat <<\'J\'\n' + JSON.stringify({ blocks: [
      { totalTokens: 150000000, isActive: false },
      { totalTokens: 61400000, isActive: true, projection: { remainingMinutes: 178, totalTokens: 118000000 } }] }) + '\nJ\n', { mode: 0o755 })
    writeFileSync(join(d, 't.jsonl'), '{"type":"assistant","message":{"usage":{"input_tokens":10}}}\n')
    const payload = JSON.stringify({ session_id: 'demo-1', transcript_path: join(d, 't.jsonl'), cwd: '/tmp/shop',
      model: { display_name: 'Sonnet' }, workspace: { current_dir: '/tmp/shop' },
      context_window: { current_usage: { cache_creation_input_tokens: 2000, cache_read_input_tokens: 90000, input_tokens: 30 } } })
    const line = spawnSync('python3', [join(REPO, 'crew', 'claude', 'statusline.py')], {
      input: payload, encoding: 'utf8',
      env: { PATH: `${join(d, 'bin')}:/usr/bin:/bin:/opt/homebrew/bin`, HOME: join(d, 'home'),
        CREW_LOCAL: join(d, 'home', 'local'), CLAUDE_CONFIG_DIR: join(d, 'home', '.claude') },
    }).stdout.trim()
    const box = '─'.repeat(78)
    const browser = await chromium.launch()
    const p = await browser.newPage({ viewport: { width: 900, height: 260 } })
    await p.goto(pathToFileURL(join(HERE, 'term.html')).href + `?xterm=${encodeURIComponent(XTERM)}`)
    await p.waitForFunction(() => window.ready)
    await p.evaluate((s) => window.play([{ t: 0, d: s }], 1),
      `${C.or}⏺${C.r} Tests pass. Increment 2 is ready for its checks.\r\n\r\n${C.d}${box}${C.r}\r\n${C.b}>${C.r} \r\n${C.d}${box}${C.r}\r\n  ${line}\r\n`)
    await p.waitForTimeout(300)
    await shot(p, 'crew-statusline')
    await browser.close()
  }
  // the usage-billing layout, as a still
  {
    const d = mockUsage()
    d.billing = 'usage'
    d.month = { cost: 1840, budget: 3500, projected: 3320, unpriced: 0, days: 31, day: 29 }
    const browser = await chromium.launch()
    const p = await browser.newPage({ viewport: { width: 700, height: TALL }, colorScheme: 'dark' })
    await p.goto(usageFile(d, 'usage-billing.html'))
    await p.waitForTimeout(600)
    await shot(p, 'crew-usage-billing')
    await browser.close()
  }
}

// ── V6: the seamux app ────────────────────────────────────────────────────
// The app's own pages from app/ui, in Vite, with ../app/mock.js standing in
// for Tauri and cmux: five shop workspaces, nothing of yours.

async function v6() {
  const app = await import('../app/shoot.mjs')
  const srv = await app.startServer()
  try {
    await film('v6-app', { viewport: { width: 1440, height: 900 }, label: 'seamux',
      prepare: (page) => app.openApp(page, 'dock', { url: srv.url }) }, async ({ rec, page, say }) => {
      say('Every agent, one hotkey away.')
      await rec.wait(3200)
      await rec.click('.dock-new')
      say('Start a workspace in one form.')
      await rec.type('.newws-prompt', "Show the coupon's discount on the receipt, under the total.")
      await rec.wait(800)
      await rec.click('.newws-go')
      await rec.wait(4200)
      await rec.click('#strip .tab:has-text("Mosaic")')
      say('Reply without switching.')
      await rec.wait(1600)
      await rec.click('.m-tile.large .d-opt >> nth=0')
      await rec.wait(3400)
      await rec.click('#strip .tab:has-text("Timeline")')
      say('See who waited, and how long.')
      await rec.wait(3400)
    })
  } finally {
    await srv.close()
  }
}

// ── stills: screenshots no video needs ────────────────────────────────────

async function termStill(file, beats, { width = 1200, height = 640 } = {}) {
  const cast = build(beats, { scrub: W.scrub })
  const browser = await chromium.launch()
  const p = await browser.newPage({ viewport: { width, height } })
  await p.goto(pathToFileURL(join(HERE, 'term.html')).href + `?xterm=${encodeURIComponent(XTERM)}`)
  await p.waitForFunction(() => window.ready)
  await p.evaluate((c) => window.play(c.map((x) => ({ t: 0, d: x.d })), 1), cast.chunks)
  await p.waitForTimeout(300)
  await shot(p, file)
  await browser.close()
}

async function stills() {
  stage('stills')
  // verify init: drafts recipes from what the repo already runs
  rmSync(join(W.shop, '.seamux'), { recursive: true, force: true })
  sh('git add -A && git commit -qm "no recipes yet"')
  await termStill('dp-verify-init', [run('deep-plan verify init')], { height: 760 })
  sh('git revert --no-edit HEAD >/dev/null')
  // the working page with checks in every state: passed, failed, running, a person's step, pending
  cpSync(join(REPO, 'docs', 'demo', 'world', 'demo-coupons.spec.json'), join(W.dir, 'demo-coupons.spec.json'))
  sh(`node ${DP} render ${W.dir}/demo-coupons.spec.json --root ${W.shop} >/dev/null`)
  sh(`node ${DP} grade demo-coupons ${answers('demo-coupons')} >/dev/null && node ${DP} go demo-coupons 1 >/dev/null`)
  mkdirSync(join(W.shop, 'src', 'coupons'), { recursive: true })
  writeFileSync(join(W.shop, 'src', 'coupons', 'lookup.js'), "var CODES = { WELCOME10: 10 }\nexport const lookup = (c) => CODES[c.toUpperCase()] ?? null\n")
  sh(`node ${DP} check run demo-coupons 1 >/dev/null`, { ok: false })
  sh(`node ${DP} go demo-coupons 2 --force >/dev/null; node ${DP} check run demo-coupons 2 e2e >/dev/null`, { ok: false })
  const url = served(sh(`node ${DP} page demo-coupons`))
  const browser = await chromium.launch()
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  await p.goto(url)
  await p.waitForTimeout(1500)
  await shot(p, 'dp-checks-working', 'section:has(h2:text("Increments"))')
  await browser.close()
}

// ── main ──────────────────────────────────────────────────────────────────

const VIDEOS = {
  v1: { fn: v1, line: 'One change, start to finish',
    clips: ['v1-ask', 'v1-askpage', 'v1-render', 'v1-review', 'v1-gate', 'v1-checks', 'v1-working', 'v1-build2',
      'v1-reviewer', 'v1-lookout', 'v1-ship', 'v1-deliver'] },
  v2: { fn: v2, line: 'One goal, several agents', clips: ['v2-parent', 'v2-family'] },
  v3: { fn: v3, line: 'Where it runs, and with whom', clips: ['v3-hosts'] },
  v4: { fn: v4, line: 'Small tools', clips: ['v4-restack', 'v4-humanize'] },
  v5: { fn: v5, line: 'The crew board', clips: ['v5-board', 'v5-usage'] },
  v6: { fn: v6, line: 'The seamux app', clips: ['v6-app'] },
  stills: { fn: stills, clips: [] },
}

const names = wanted.length ? wanted : Object.keys(VIDEOS)
for (const n of names) {
  if (!VIDEOS[n]) { console.error(`unknown video ${n} (have ${Object.keys(VIDEOS).join(', ')})`); process.exit(2) }
}
mkdirSync(join(OUT, '.raw'), { recursive: true })
for (const n of names) {
  console.log(`${n}: ${VIDEOS[n].line}`)
  try {
    await VIDEOS[n].fn()
  } finally {
    unstage()
  }
  const clips = VIDEOS[n].clips.filter((c) => existsSync(join(OUT, c + '.mp4')))
  if (clips.length) stitch(clips, VIDEOS[n].line, `seamux-${n}.mp4`)
}
