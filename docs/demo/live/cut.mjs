// cut — the take, edited: each shot composed on a 1920x1080 canvas, shots
// joined with short dips on the music's beat grid, the soundtrack under it.
//
//   node docs/demo/live/cut.mjs edit.json [ROOT] [--stills]
//
// edit.json: { "shots": [ shot, ... ] } where a shot is
//   { "card": "intro" | "outro", "beats": 6 }                  a title card
//   { "at": "beat-name" | seconds, "from": +s, "beats": 8,     app footage from
//     "speed": 1, "crop": [x, y, w, h], "label": "…", "line": "…" }
// `at` + `from` is where the shot starts in the take (ROOT/take/beats.tsv
// names), `beats` its length on screen (one beat is 60/96 s), `speed` how fast
// the take plays, `crop` a 16:9 part of the window in its points (the window
// is 1600x900), `label` and `line` the caption.
//
// "take": "take1" reads that shot from ROOT/take1 instead of ROOT/take (a
// top-level "take" sets the default). "win": "cloud" reads the cloud window's
// recording (cloud.mp4, its start in cloud.offset; 1280x720 points, title bar
// always cropped off). { "split": [shotA, shotB], "beats", "label", "line" }
// shows two sources side by side, each with its "tag" above it.
// Top-level "name" names the output, "intro" and "outro" the cards' words:
//   "intro": { "line": "…" }, "outro": { "items": ["…"], "url": "…" }
// --stills writes one PNG per shot (its middle frame) to ROOT/cut/stills and
// stops: look at those before the full render.
// Output: ROOT/cut/seamux-app-demo.mp4, its poster ROOT/cut/poster.jpg.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(HERE, '../reel/package.json'))
const ffmpeg = require('ffmpeg-static')
const { chromium } = require('playwright-core')

const args = process.argv.slice(2)
const STILLS = args.includes('--stills')
const [editFile, rootArg] = args.filter((a) => !a.startsWith('--'))
const ROOT = rootArg || '/private/tmp/seamux-demo'
const edit0 = JSON.parse(readFileSync(editFile, 'utf8'))
const NAME = edit0.name || 'seamux-app-demo'
const OUT = join(ROOT, edit0.name ? 'cut-' + edit0.name : 'cut')
const BEAT = 60 / 96
const W = 1920, H = 1080
const FRAME = { x: 192, y: 34, w: 1536, h: 864 }
const CLOUD_CROP = [16, 28, 1230, 692] // the cloud window without its title bar (it names your user)
const SPLIT = { w: 912, h: 513, y: 236, xs: [36, 972] }
const XF = BEAT / 2 // the dip between shots

const edit = edit0
// A shot may come from another take ("take": "take1", a folder beside take/).
const takeDir = (s) => join(ROOT, s.take || edit.take || 'take')
const beatsOf = {}
const beatsFor = (s) => (beatsOf[takeDir(s)] ??= Object.fromEntries(readFileSync(join(takeDir(s), 'beats.tsv'), 'utf8').trim().split('\n')
  .map((l) => l.split('\t')).map(([t, n]) => [n, Number(t)])))
mkdirSync(join(OUT, 'png'), { recursive: true })

function ff(a) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + a.join(' ').slice(0, 400))
}

// ── the pictures: canvas, frame, captions, cards ──────────────────────────
const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif`
const C = { bg0: '#1b2023', bg1: '#232a2e', sand: '#d3c6aa', green: '#a7c080', grey: '#859289', line: '#3a464c', amber: '#dbbc7f' }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const page = (body, css = '') => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; background: transparent; overflow: hidden; }
  * { box-sizing: border-box; } ${css}</style>${body}`

const PNG = {
  bg: page(`<div class="bg"></div>`, `.bg { position: absolute; inset: 0;
    background: radial-gradient(1400px 900px at 50% 38%, ${C.bg1} 0%, ${C.bg0} 70%); }
    .bg::after { content: ""; position: absolute; inset: 0; opacity: .5;
    background-image: radial-gradient(rgba(211,198,170,.06) 1px, transparent 1px); background-size: 28px 28px; }`),
  shadow: page(`<div class="s"></div>`, `.s { position: absolute; left: ${FRAME.x}px; top: ${FRAME.y}px;
    width: ${FRAME.w}px; height: ${FRAME.h}px; border-radius: 14px;
    box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(211,198,170,.10); }`),
  mask: `<!doctype html><style>html,body{margin:0;width:${FRAME.w}px;height:${FRAME.h}px;background:#000}
    div{width:100%;height:100%;border-radius:14px;background:#fff}</style><div></div>`,
}
const caption = (label, line) => page(`<div class="cap"><div class="lb">${esc(label)}</div><div class="ln">${esc(line)}</div></div>`,
  `.cap { position: absolute; left: ${FRAME.x}px; top: ${FRAME.y + FRAME.h + 30}px; width: ${FRAME.w}px; font-family: ${FONT}; }
   .lb { font: 700 21px/1 ${FONT}; letter-spacing: 3px; text-transform: uppercase; color: ${C.green}; margin-bottom: 14px; }
   .ln { font: 600 40px/1.15 ${FONT}; color: ${C.sand}; letter-spacing: -.3px; }`)
const word = `<span style="color:${C.sand}">sea</span><span style="color:${C.green}">mux</span>`
const CARDS = {
  intro: page(`<div class="c"><h1>${word}</h1><p>${esc(edit0.intro?.line ?? 'Every Claude Code session, in one window.')}</p></div>`,
    `.c { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; font-family: ${FONT}; }
     h1 { margin: 0; font: 800 150px/1 ${FONT}; letter-spacing: -5px; }
     p { margin: 0; font: 500 46px/1.2 ${FONT}; color: ${C.grey}; }`),
  outro: page(`<div class="c"><h1>${word}</h1>
    <ul>${(edit0.outro?.items ?? ['Plans you read before any code.', 'Questions that come to you.', 'Guards that hold.']).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <p class="u">${esc(edit0.outro?.url ?? 'github.com/rickykoter/seamux')}</p></div>`,
    `.c { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; font-family: ${FONT}; }
     h1 { margin: 0; font: 800 132px/1 ${FONT}; letter-spacing: -4px; }
     ul { margin: 0; padding: 0; list-style: none; display: flex; gap: 46px; }
     li { font: 600 36px/1.2 ${FONT}; color: ${C.sand}; }
     li::before { content: ""; display: inline-block; width: 12px; height: 12px; border-radius: 3px; background: ${C.amber}; margin: 0 16px 6px 0; }
     .u { margin: 18px 0 0; font: 500 30px/1 ui-monospace, "SF Mono", Menlo, monospace; color: ${C.grey}; }`),
}

async function renderPngs() {
  const browser = await chromium.launch()
  const p = await browser.newPage({ viewport: { width: W, height: H } })
  const shoot = async (html, file, size) => {
    if (size) await p.setViewportSize(size); else await p.setViewportSize({ width: W, height: H })
    await p.setContent(html); await p.evaluate(() => document.fonts.ready)
    await p.screenshot({ path: join(OUT, 'png', file), omitBackground: true })
  }
  await shoot(PNG.bg, 'bg.png'); await shoot(PNG.shadow, 'shadow.png')
  await shoot(PNG.mask, 'mask.png', { width: FRAME.w, height: FRAME.h })
  await shoot(PNG.mask.replaceAll(`${FRAME.w}px`, `${SPLIT.w}px`).replaceAll(`${FRAME.h}px`, `${SPLIT.h}px`), 'mask-split.png', { width: SPLIT.w, height: SPLIT.h })
  for (const [k, html] of Object.entries(CARDS)) await shoot(html, `card-${k}.png`)
  for (const [i, s] of edit.shots.entries()) if (s.split) await shoot(page(s.split.map((p, j) => `<div class="t" style="left:${SPLIT.xs[j]}px">${esc(p.tag || '')}</div>`).join('') +
    s.split.map((p, j) => `<div class="s" style="left:${SPLIT.xs[j]}px"></div>`).join(''),
    `.t { position: absolute; top: ${SPLIT.y - 46}px; font: 700 21px/1 ${FONT}; letter-spacing: 3px; text-transform: uppercase; color: ${C.grey}; }
     .s { position: absolute; top: ${SPLIT.y}px; width: ${SPLIT.w}px; height: ${SPLIT.h}px; border-radius: 14px;
          box-shadow: 0 24px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(211,198,170,.10); }`), `split-${i}.png`)
  for (const [i, s] of edit.shots.entries()) if (s.label || s.line) await shoot(caption(s.label || '', s.line || ''), `cap-${i}.png`)
  await browser.close()
}

// ── shots ─────────────────────────────────────────────────────────────────
const at = (s) => (typeof s.at === 'number' ? s.at : beatsFor(s)[s.at]) + (s.from || 0)
const parts = edit.shots.flatMap((s) => (s.split ? s.split.map((p) => ({ take: s.take, ...p })) : s.card ? [] : [s]))
for (const s of parts) if (!Number.isFinite(at(s))) throw new Error(`no beat ${s.at} in beats.tsv`)
// Where a source's footage is, and when the shot starts in it.
const source = (s) => s.win === 'cloud'
  ? { file: join(takeDir(s), 'cloud.mp4'), t: at(s) - Number(readFileSync(join(takeDir(s), 'cloud.offset'), 'utf8')), crop: s.crop || CLOUD_CROP, lights: false }
  : { file: join(takeDir(s), 'app.mp4'), t: at(s), crop: s.crop, lights: !s.crop }

// Where the screen-share pill sits on the recorded title bar: covered by
// the window's own (inactive) traffic lights.
const LIGHTS = `drawbox=x=0:y=0:w=150:h=56:color=0x2b3136:t=fill,` +
  [26, 54, 82].map((x) => `drawbox=x=${x * 2 - 12}:y=${26 * 2 - 12}:w=24:h=24:color=0x4f565b:t=fill`).join(',')

function shot(i, s, file) {
  const dur = s.beats * BEAT + XF
  const png = (f) => join(OUT, 'png', f)
  if (s.card) {
    ff(['-loop', '1', '-t', String(dur), '-i', png('bg.png'), '-loop', '1', '-t', String(dur), '-i', png(`card-${s.card}.png`),
      '-filter_complex', `[0:v][1:v]overlay=0:0,fps=30,format=yuv420p[v]`, '-map', '[v]',
      '-c:v', 'libx264', '-crf', '12', '-preset', 'medium', file])
    return
  }
  const cap = existsSync(png(`cap-${i}.png`))
  // One source, as a framed stream [o] of w x h, from input number k.
  const src = (p, k, w, h, o) => {
    const sp = p.speed || 1, S = source(p), sc = 2 // the takes are the windows at 2x
    const crop = S.crop ? `crop=${S.crop[2] * sc}:${S.crop[3] * sc}:${S.crop[0] * sc}:${S.crop[1] * sc},` : ''
    return { input: ['-ss', String(Math.max(0, S.t)), '-t', String(dur * sp + 0.5), '-i', S.file],
      fc: `[${k}:v]setpts=(PTS-STARTPTS)/${sp},fps=30,${S.lights ? LIGHTS + ',' : ''}${crop}scale=${w}:${h}:flags=lanczos,format=rgba,trim=duration=${dur}[${o}]` }
  }
  const loop = (f) => ['-loop', '1', '-t', String(dur), '-i', png(f)]
  let inputs, fc
  if (s.split) {
    const a = src(s.split[0], 0, SPLIT.w, SPLIT.h, 'a'), b = src(s.split[1], 1, SPLIT.w, SPLIT.h, 'b')
    inputs = [...a.input, ...b.input, ...loop('bg.png'), ...loop(`split-${i}.png`), ...loop('mask-split.png')]
    fc = [a.fc, b.fc, `[4:v]format=gray,split[m1][m2]`, `[a][m1]alphamerge[am]`, `[b][m2]alphamerge[bm]`,
      `[2:v][3:v]overlay=0:0[b0]`, `[b0][am]overlay=${SPLIT.xs[0]}:${SPLIT.y}:shortest=1[b1]`, `[b1][bm]overlay=${SPLIT.xs[1]}:${SPLIT.y}:shortest=1[b2]`]
    if (cap) { inputs.push(...loop(`cap-${i}.png`)); fc.push(`[5:v]format=rgba,fade=t=in:st=${XF}:d=0.35:alpha=1[c]`, `[b2][c]overlay=0:0,format=yuv420p[v]`) }
    else fc.push(`[b2]format=yuv420p[v]`)
  } else {
    const a = src(s, 0, FRAME.w, FRAME.h, 'app')
    inputs = [...a.input, ...loop('bg.png'), ...loop('shadow.png'), ...loop('mask.png')]
    fc = [a.fc, `[3:v]format=gray,scale=${FRAME.w}:${FRAME.h}[m]`, `[app][m]alphamerge[am]`, `[1:v][2:v]overlay=0:0[b0]`,
      `[b0][am]overlay=${FRAME.x}:${FRAME.y}:shortest=1[b1]`]
    if (cap) { inputs.push(...loop(`cap-${i}.png`)); fc.push(`[4:v]format=rgba,fade=t=in:st=${XF}:d=0.35:alpha=1[c]`, `[b1][c]overlay=0:0,format=yuv420p[v]`) }
    else fc.push(`[b1]format=yuv420p[v]`)
  }
  ff([...inputs, '-filter_complex', fc.join(';'), '-map', '[v]', '-t', String(dur), '-c:v', 'libx264', '-crf', '12', '-preset', 'medium', '-r', '30', file])
}

await renderPngs()
const files = []
for (const [i, s] of edit.shots.entries()) {
  const f = join(OUT, `shot-${String(i).padStart(2, '0')}.mp4`)
  shot(i, s, f); files.push(f)
  if (STILLS) {
    mkdirSync(join(OUT, 'stills'), { recursive: true })
    ff(['-ss', String((s.beats * BEAT) / 2 + XF), '-i', f, '-frames:v', '1', join(OUT, 'stills', `${String(i).padStart(2, '0')}.png`)])
  }
  console.log(`shot ${i}: ${s.card || (s.split ? 'split' : s.at)} ${s.beats} beats${s.speed ? ' x' + s.speed : ''}`)
}
if (STILLS) { console.log(`stills in ${join(OUT, 'stills')}`); process.exit(0) }

// ── join: dips between shots, every cut on the grid ───────────────────────
let fc = '', last = '[0:v]', t = 0
const cuts = []
for (let i = 1; i < files.length; i++) {
  t += edit.shots[i - 1].beats * BEAT
  cuts.push(t)
  fc += `${last}[${i}:v]xfade=transition=fadeblack:duration=${XF}:offset=${t.toFixed(4)}[x${i}];`
  last = `[x${i}]`
}
const total = t + edit.shots.at(-1).beats * BEAT + XF
writeFileSync(join(OUT, 'accents.json'), JSON.stringify(cuts))
const wav = join(OUT, 'music.wav')
const m = spawnSync(process.execPath, [join(HERE, 'music.mjs'), wav, String(total), join(OUT, 'accents.json')], { stdio: 'inherit' })
if (m.status !== 0) throw new Error('music failed')
const video = join(OUT, `${NAME}.mp4`)
ff([...files.flatMap((f) => ['-i', f]), '-i', wav, '-filter_complex', fc.replace(/;$/, '').replace(new RegExp(`\\[x${files.length - 1}\\]$`), '[v]'),
  '-map', '[v]', '-map', `${files.length}:a`, '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', join(OUT, 'joined.mp4')])

// The poster: a settled frame of edit.poster's shot (default the first app
// shot), saved and baked in as frame 0 so a thumbnail shows it.
const pi = edit.poster ?? edit.shots.findIndex((s) => !s.card)
const pt = edit.shots.slice(0, pi).reduce((a, s) => a + s.beats * BEAT, 0) + edit.shots[pi].beats * BEAT * 0.75
const poster = join(OUT, 'poster.jpg')
ff(['-ss', pt.toFixed(3), '-i', join(OUT, 'joined.mp4'), '-frames:v', '1', '-q:v', '2', poster])
ff(['-i', join(OUT, 'joined.mp4'), '-i', poster, '-filter_complex', `[0:v][1:v]overlay=0:0:enable='eq(n,0)',format=yuv420p[v]`,
  '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-c:a', 'copy', '-movflags', '+faststart', video])
rmSync(join(OUT, 'joined.mp4'))
console.log(`cut: ${video} (${total.toFixed(1)}s), poster ${poster}`)
