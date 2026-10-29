#!/usr/bin/env node
// record — the README Tour's web scenes, scripted with testreel.
//
//   npm install                       once, in this folder
//   node record.mjs                   every scene
//   node record.mjs board plan        just these
//   node record.mjs --out DIR         default ~/Movies/seamux-reel
//
// Each scene is the shipped page, rendered off-screen in Playwright and fed demo
// data, so a re-take after a UI change is one command instead of a re-shoot:
//
//   board  board.html + render.js, pushed the board-demo.py cast (--dump) the
//          same way crew-board pushes it: renderer and state in one script.
//   usage  usage.tmpl.html with mock-usage data in place of __DATA__. The live
//          /usage reads your real spend, which is not demo material.
//   plan   the example plan's review page from the running intent server, so
//          its diagrams load. Render it first:
//            deep-plan render deep-plan/examples/example.spec.json
//   parent a family's parent plan (examples/example.family.spec.json), staged
//          by family-fixture.sh in a throwaway folder: nothing lands in your
//          plan state, and the page inlines its own mermaid.
//   famboard  the board again after the live family take: the same cast's
//          family scenes, grouped and shaded.
//
// Terminal scenes are not here: testreel only records a browser. take.md covers
// recording those with cmux-cua, and stitch.mjs frames and joins everything.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { recordPage } from 'testreel'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const BOARD = join(REPO, 'crew', 'board')
const PLAN_SLUG = 'example-outbox-retry'
const FAMILY_SLUG = 'example-auth-revamp'

const argv = process.argv.slice(2)
const outAt = argv.indexOf('--out')
const OUT = outAt >= 0 ? argv[outAt + 1] : join(homedir(), 'Movies', 'seamux-reel')
const wanted = argv.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1))

// Windows only: stitch.mjs puts every clip, terminal included, on one canvas.
// Sized so a window (viewport + 38px title bar) lands on the 1920x1080 canvas
// at 1:1 inside its 72px margin -- an upscaled Playwright frame looks soft.
const TALL = 860

// The board and /usage are built for a narrow Dock column; at 1:1 on a 1080p
// canvas their type is unreadable. CSS zoom enlarges the page, not the frame,
// so the result stays sharp where scaling the video up would blur it. On body,
// not html: testreel's zoom is a transform on html, and html's own zoom would
// scale that transform's translate too, so every zoom would miss its target.
const enlarge = (page, k) => page.addStyleTag({ content: `body { zoom: ${k} }` })

async function scene(name, { viewport, label, prepare }, body) {
  // Staging runs before the recording starts, so its time isn't filmed.
  const prep = prepare ? prepare() : null
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'dark', // the plan page follows it; the board and /usage are dark already
    recordVideo: { dir: join(OUT, '.raw'), size: viewport },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  const videoStartedAt = Date.now()
  // Captions are stamped against the video's clock as the beat happens, so a
  // re-take can't leave them out of sync. stitch.mjs reads <name>.captions.json.
  const captions = []
  const say = (text) => captions.push({ at: (Date.now() - videoStartedAt) / 1000, text })
  const rec = await recordPage(page, {
    videoStartedAt,
    name,
    outputDir: OUT,
    outputFormat: 'mp4',
    chrome: { url: label, titleBarColor: '#2b3135' },
    background: false,
    cursor: { size: 40, rippleColor: 'rgba(219, 188, 127, 0.45)' },
  })
  try {
    await body(rec, page, say, prep)
  } catch (err) {
    await rec.stop().catch(() => {})
    await browser.close()
    prep?.cleanup()
    throw err
  }
  const result = await rec.stop()
  await browser.close()
  prep?.cleanup()
  writeFileSync(join(OUT, `${name}.captions.json`), JSON.stringify(captions, null, 2) + '\n')
  console.log(`${name}: ${result.video}`)
  return result.video
}

// ── board ─────────────────────────────────────────────────────────────────
// The story: a search agent finishes and its row ripples down, then `go 3`
// authorizes the gated increment, a new question jumps to the top, and the
// red checks go green. The chips are inert here (no intent server is wired),
// so the click is the cursor's and the push after it is the board's answer.

function boardCast() {
  const out = execFileSync('python3', [join(REPO, 'docs', 'demo', 'board-demo.py'), '--dump'])
  return JSON.parse(out).map((s) => s.state)
}

// Opens board.html and returns push(state), which renders a state the way a
// crew-board push does.
async function boardPage(page) {
  const renderer = readFileSync(join(BOARD, 'render.js'), 'utf8')
  await page.goto(pathToFileURL(join(BOARD, 'board.html')).href)
  await enlarge(page, 1.5)
  return (state) =>
    page.evaluate(([js, d]) => {
      const s = document.createElement('script')
      s.textContent = js + '\n__boardRender(' + JSON.stringify(d) + ');'
      document.head.appendChild(s)
      s.remove()
    }, [renderer, state])
}

async function board(rec, page, say) {
  const cast = boardCast()
  const push = await boardPage(page)
  await push(cast[0])
  say('The crew board — one row per worktree, ranked by who needs you')
  await rec.wait(3200)
  await push(cast[1])
  say('Agents report progress; dials and increments update live')
  await rec.wait(3000)
  await push(cast[2]) // search-index lands: DONE, ripples below the gated rows
  say('search-index finishes — it ripples, files its PR, and steps aside')
  await rec.wait(3200)
  say('The gated increment from the terminal waits here: `go 3` approves it')
  await rec.hover('.row.attend .chip.lead')
  await rec.wait(1400)
  await rec.click('.row.attend .chip.lead', { zoom: 1.8 })
  await rec.wait(900)
  await rec.zoom({ scale: 1 }) // the click's zoom only unwinds at the next click
  await push(cast[3]) // go 3 → checkout-flow WORKING; payments-idem asks a question
  say('checkout-flow gets to work — and a new question jumps to the top')
  await rec.wait(3200)
  await push(cast[4]) // rate-limits checks go green
  say('Checks turn green on rate-limits — ready to merge')
  await rec.wait(3200)
}

// ── famboard ──────────────────────────────────────────────────────────────
// After the live family take, the same family on the board: it sits together
// in its shades under checkout-flow, then its ui workstream reaches a gate and
// the whole family moves to the top (cast scenes 5 and 6).

async function famboard(rec, page, say) {
  const cast = boardCast()
  const push = await boardPage(page)
  await push(cast[5])
  say('On the board a family sits together: the parent, then its workstreams in its shades')
  await rec.wait(1400)
  await rec.hover(`.row[data-id="${FAMILY_SLUG}"]`)
  await rec.wait(2400)
  await push(cast[6])
  say('example-auth-ui reaches its gate, and the whole family moves up with it')
  await rec.wait(1200)
  await rec.hover('.row[data-id="example-auth-ui"] .chip.lead')
  await rec.wait(2600)
}

// ── usage ─────────────────────────────────────────────────────────────────

export function mockUsage() {
  const day = 86400e3
  const now = Date.now()
  const iso = (t) => new Date(t).toISOString().slice(0, 10)
  // A weekday-shaped curve, so the bars read as a working month, not noise.
  const daily = Array.from({ length: 21 }, (_, i) => {
    const t = now - (20 - i) * day
    const dow = new Date(t).getDay()
    const base = dow === 0 || dow === 6 ? 9e6 : 52e6
    const tokens = Math.round(base * (0.75 + 0.5 * Math.abs(Math.sin(i * 1.7))))
    return { period: iso(t), tokens, cost: +(tokens / 6.8e5).toFixed(2) }
  })
  const start = new Date(Math.floor(now / 3600e3) * 3600e3 - 2 * 3600e3)
  return {
    windowMinutes: 300,
    block: {
      tokens: 61_400_000, budget: 150_000_000, projected: 118_000_000,
      remainingMinutes: 178, burnPerMinute: 405_000, entries: 412,
      models: ['claude-opus-5-5', 'claude-haiku-4-5-20251001'], active: true,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 300 * 60e3).toISOString(),
      windowMinutes: 300,
    },
    blockBudget: 150_000_000,
    budgetSource: 'largest 5h window on record',
    daily,
    week: {
      label: 'week of ' + iso(now - new Date(now).getDay() * day),
      tokens: 214_000_000, cost: 312.4, budget: 340_000_000,
      models: [{ name: 'opus-5-5', tokens: 171_000_000 }, { name: 'haiku-4-5', tokens: 43_000_000 }],
    },
    billing: 'subscription',
    costs: [
      { name: 'rate-limits', today: 3.1, week: 12.02 },
      { name: 'checkout-flow', today: 4.31, week: 9.88 },
      { name: 'login-copy', today: 0, week: 2.05 },
      { name: 'payments-idem', today: 1.14, week: 1.14 },
      { name: 'search-index', today: 0.62, week: 0.62 },
    ],
    cache: {
      today: { breaks: 2, tokens: 640_000 },
      week: { breaks: 9, tokens: 2_910_000 },
      causes: { 'ttl-gap': 6, compaction: 2, 'model-switch': 1 },
      sessions: [
        { name: 'rate-limits', tokens: 1_210_000, breaks: 3 },
        { name: 'checkout-flow', tokens: 880_000, breaks: 3 },
        { name: 'payments-idem', tokens: 420_000, breaks: 2 },
      ],
    },
  }
}

async function usage(rec, page, say) {
  const tmpl = readFileSync(join(BOARD, 'usage.tmpl.html'), 'utf8')
  const file = join(OUT, '.raw', 'usage.html')
  writeFileSync(file, tmpl.replaceAll('__DATA__', () => JSON.stringify(mockUsage())))
  await page.goto(pathToFileURL(file).href)
  await enlarge(page, 1.4)
  say('/usage — tokens against your 5-hour and weekly budgets')
  await rec.wait(2000)
  await rec.hover('#plot')
  await rec.wait(1800)
  await rec.scroll({ y: 520 })
  say('…and dollars per workspace, so the one quietly burning money stands out')
  await rec.wait(3200)
  // A hover, not a zoom: the cards are full width, so any zoom crops them.
  await rec.hover('h2:text("Cache re-writes")')
  say('Cache re-writes — what broke the prompt cache this week, and why')
  await rec.wait(3400)
}

// ── plan ──────────────────────────────────────────────────────────────────

async function intentBase() {
  const port = readFileSync(join(homedir(), '.cache', 'cmux-crew', 'board-intent.port'), 'utf8').trim()
  const base = `http://127.0.0.1:${port}`
  const r = await fetch(`${base}/plan/${PLAN_SLUG}.review.html`).catch(() => null)
  if (!r || !r.ok) {
    throw new Error(`plan page not served at ${base}. Is the intent server up (crew doctor), ` +
      `and is the plan rendered? deep-plan render deep-plan/examples/example.spec.json`)
  }
  return base
}

// testreel's eased scroll, aimed at an element instead of a pixel delta.
// (scrollIntoViewIfNeeded jumps, which reads as a cut.)
async function scrollTo(rec, page, sel, top = 110) {
  const y = await page.locator(sel).evaluate((e) => e.getBoundingClientRect().top)
  await rec.scroll({ y: Math.round(y - top) })
}

async function plan(rec, page, say) {
  const base = await intentBase()
  await page.goto(`${base}/plan/${PLAN_SLUG}.review.html`)
  await enlarge(page, 1.4)
  await page.waitForSelector('svg[id^="mermaid"], .mermaid svg', { timeout: 8000 }).catch(() => {})
  say('deep-plan — the plan rendered for review: context, decisions, evidence')
  await rec.wait(2800)
  await rec.hover('.dp-adr-promote')
  say('Decisions worth keeping become draft ADRs for your docs/adr')
  await rec.wait(2400)
  await rec.scroll({ y: 900 })
  say('Claims arrive cited, or listed as risks — sub-agents checked them first')
  await rec.wait(2600)
  await rec.scroll({ y: 1100 })
  await rec.wait(1800)
  await scrollTo(rec, page, '#dp-p-q1')
  say('The alignment quiz — three questions check that you and the plan agree')
  await rec.wait(1200)
  // The answers this render's check expects (see board-demo.py's docstring).
  // The radio, not its label: labels are full width, so their centre is empty
  // space. No zoom: the enlarged column is wider than any zoomed view.
  const opt = (q, v) => `input[name="dp-q-${q}"][value="${v}"]`
  await rec.click(opt('q1', 'a'))
  await rec.click(opt('q2', 'c'))
  await scrollTo(rec, page, '#dp-p-q3')
  await rec.click(opt('q3', 'd'))
  await rec.wait(900)
  await scrollTo(rec, page, '#dp-copyback', 380)
  say('Copy for session pastes your answers back; the agent grades, then waits for `go`')
  await rec.click('#dp-copyback', { zoom: 1.5 })
  await rec.wait(3000)
}

// ── parent ────────────────────────────────────────────────────────────────

function stageFamily() {
  const dir = mkdtempSync(join(tmpdir(), 'seamux-reel-family-'))
  execFileSync('bash', [join(REPO, 'deep-plan', 'tools', 'family-fixture.sh'), dir],
    { stdio: ['ignore', 'ignore', 'inherit'] })
  return {
    file: join(dir, 'plans', `${FAMILY_SLUG}.review.html`),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

async function parent(rec, page, say, { file }) {
  await page.goto(pathToFileURL(file).href)
  await enlarge(page, 1.4)
  await page.waitForSelector('svg[id^="mermaid"], .mermaid svg', { timeout: 8000 }).catch(() => {})
  say('A change too big for one plan becomes a family: a parent and its workstreams')
  await rec.wait(2800)
  await scrollTo(rec, page, 'h2:text("Workstreams")')
  say('Each workstream is its own plan in its own worktree, and owns its files')
  await rec.wait(3400)
  await scrollTo(rec, page, 'h2:text("What waits on what?")')
  say('The parent lands the shared piece first; both workstreams build on it')
  await rec.wait(3400)
}

const SCENES = {
  board: [{ viewport: { width: 700, height: TALL }, label: 'crew · who needs you' }, board],
  usage: [{ viewport: { width: 700, height: TALL }, label: '127.0.0.1/usage' }, usage],
  plan: [{ viewport: { width: 1440, height: TALL }, label: `127.0.0.1/plan/${PLAN_SLUG}` }, plan],
  parent: [{ viewport: { width: 1440, height: TALL }, label: `127.0.0.1/plan/${FAMILY_SLUG}`,
    prepare: stageFamily }, parent],
  famboard: [{ viewport: { width: 700, height: TALL }, label: 'crew · who needs you' }, famboard],
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = wanted.length ? wanted : Object.keys(SCENES)
  const bad = names.filter((n) => !SCENES[n])
  if (bad.length) {
    console.error(`unknown scene: ${bad.join(', ')} (have: ${Object.keys(SCENES).join(', ')})`)
    process.exit(2)
  }
  mkdirSync(join(OUT, '.raw'), { recursive: true })
  for (const n of names) await scene(n, SCENES[n][0], SCENES[n][1])
}
