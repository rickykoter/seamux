#!/usr/bin/env node
// cut — edit a long screen recording into a standalone 1920x1080 clip.
//
//   node cut.mjs <name>             reads DIR/<name>.cut.json, writes DIR/<name>.mp4
//   node cut.mjs <name> --out DIR   default ~/Movies/seamux-reel
//
// stitch.mjs frames short clips on the Tour's canvas. A take like
// family-e2e.sh's runs for minutes, mostly waiting on models, and is shown full
// screen, so it is edited as a list of shots, crossfaded in order:
//
//   { "source": ".raw/e2e.mov",           relative to DIR
//     "origin": [0, 66],                  where "base" coordinates start in the
//                                         source (the menu bar sits above it)
//     "base": [3456, 2013],               the full view: width, height
//     "shots": [ ... ] }
//
// Every rectangle is [x, y, w, h] in base coordinates; every time is in source
// seconds. Shots:
//
//   { "title": "…", "line": "…", "secs": 3 }                  a title card
//   { "from": 0, "to": 52, "speed": 8,                        a span of the recording
//     "view": [x, y, w, h],               the region shown (default: all of base);
//                                         16:9 fills the frame, anything else is
//                                         centred on the background
//     "caption": "…",                     one pill for the whole shot
//     "highlight": [{ "rect": [...], "from": s, "to": s, "hold": 2.5 }] }
//                                         a spotlight: the rest dims, the rect is
//                                         outlined (from/to default to the shot);
//                                         hold pauses on the frame where it comes
//                                         on, for that many seconds, before the
//                                         recording plays on
//   { "freeze": 159, "secs": 6, "view": [...], "highlight": [...],
//     "title": "…", "bullets": ["…"] }    one frame held beside a bulleted panel
//   { "freeze": 158, "secs": 6, "highlight": [...],
//     "callout": { "title": "…", "text": "…", "at": [x, y] } }
//                                         the whole frame, one spotlight, and a
//                                         small card at output pixels [x, y]:
//                                         a feature tour, one shot per feature
//   { "freeze": 158, "secs": 12, "title": "…", "line": "…",
//     "items": [{ "label": "…", "text": "…" }] }
//                                         a topsight: the frame fills the screen,
//                                         dimmed and blurred, under a card of
//                                         named features in two columns
//
// Speed a caption says out loud ("(8×)"): the clip does not label it for you.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import ffmpeg from 'ffmpeg-static'
import { renderCards } from './cards.mjs'

const W = 1920
const H = 1080
const FADE = 0.35          // crossfade between shots
const CAPTION_FADE = 0.3
const CAPTION_BOTTOM = 34
const BG = { from: [30, 35, 38], to: [58, 77, 69] }   // stitch.mjs's gradient
const SPOT = { dim: 'black@0.55', line: '0xdbbc7f', width: 6 }
// A freeze: the frame fits the left box, the panel sits in the right column.
const FREEZE_BOX = { x: 56, y: 56, w: 1180, h: 968 }
const PANEL_X = 1276

const argv = process.argv.slice(2)
const outAt = argv.indexOf('--out')
const DIR = outAt >= 0 ? argv[outAt + 1] : join(homedir(), 'Movies', 'seamux-reel')
const name = argv.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1))
if (!name) { console.error('usage: node cut.mjs <name> [--out DIR]'); process.exit(2) }
const cfgFile = join(DIR, name + '.cut.json')
if (!existsSync(cfgFile)) { console.error(`missing ${cfgFile}`); process.exit(2) }
const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
const src = join(DIR, cfg.source)
const [OX, OY] = cfg.origin || [0, 0]
const BASE = [0, 0, ...cfg.base]
const raw = (f) => join(DIR, '.raw', `${name}.${f}`)

function run(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' ').slice(0, 400))
}
const even = (n) => Math.max(2, Math.round(n / 2) * 2)

// Where a view lands inside a box, and where a base rect lands with it.
function place(view, box = { x: 0, y: 0, w: W, h: H }) {
  const [, , vw, vh] = view
  const k = Math.min(box.w / vw, box.h / vh)
  const w = even(vw * k), h = even(vh * k)
  return { k, w, h, x: Math.round(box.x + (box.w - w) / 2), y: Math.round(box.y + (box.h - h) / 2) }
}
const crop = ([x, y, w, h]) => `crop=${w}:${h}:${x + OX}:${y + OY}`

// The spotlight as drawbox filters, in output pixels, on during [a, b] (output seconds).
function spotlight(rect, view, p, a, b) {
  const [rx, ry, rw, rh] = rect
  const x = Math.round(p.x + (rx - view[0]) * p.k), y = Math.round(p.y + (ry - view[1]) * p.k)
  const w = Math.round(rw * p.k), h = Math.round(rh * p.k)
  const on = a === null ? '' : `:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`
  const box = (bx, by, bw, bh, c, t) => (bw > 0 && bh > 0) ? [`drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${c}:t=${t}${on}`] : []
  return [
    ...box(0, 0, W, y, SPOT.dim, 'fill'),
    ...box(0, y + h, W, H - y - h, SPOT.dim, 'fill'),
    ...box(0, y, x, h, SPOT.dim, 'fill'),
    ...box(x + w, y, W - x - w, h, SPOT.dim, 'fill'),
    ...box(x - SPOT.width, y - SPOT.width, w + 2 * SPOT.width, h + 2 * SPOT.width, SPOT.line, SPOT.width),
  ]
}

// ── cards: the background, titles, captions and panels, rendered once ─────
const bg = raw('bg.png')
{
  const [a, b] = [BG.from, BG.to]
  const lerp = (i) => `${a[i]}+(${b[i] - a[i]})*(X+Y)/(W+H)`
  run(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}`, '-frames:v', '1', '-vf',
    `format=rgb24,geq=r='${lerp(0)}':g='${lerp(1)}':b='${lerp(2)}'`, bg])
}
const jobs = []
cfg.shots.forEach((s, i) => {
  if (s.title && s.secs && s.freeze === undefined) jobs.push({ kind: 'title', title: { name: s.title, line: s.line || '' }, out: raw(`s${i}.title.png`) })
  if (s.caption) jobs.push({ kind: 'caption', text: s.caption, out: raw(`s${i}.cap.png`) })
  if (s.callout) jobs.push({ kind: 'callout', title: s.callout.title, text: s.callout.text, width: s.callout.width || 640, out: raw(`s${i}.panel.png`) })
  else if (s.freeze !== undefined && s.items) jobs.push({ kind: 'overview', title: s.title, line: s.line, items: s.items, out: raw(`s${i}.panel.png`) })
  else if (s.freeze !== undefined) jobs.push({ kind: 'panel', title: s.title, bullets: s.bullets || [], width: W - PANEL_X - 56, out: raw(`s${i}.panel.png`) })
})
await renderCards(jobs)

// ── shots ─────────────────────────────────────────────────────────────────
const enc = ['-an', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', '30']

// A pill over the whole shot: input `n`, fading in and out.
function captionOver(n, secs, from, to) {
  const st = 0.25, end = Math.max(st + 0.8, secs - 0.25)
  return `;[${n}:v]format=rgba,fade=t=in:st=${st}:d=${CAPTION_FADE}:alpha=1,` +
    `fade=t=out:st=${(end - CAPTION_FADE).toFixed(2)}:d=${CAPTION_FADE}:alpha=1[cap];` +
    `[${from}][cap]overlay=(W-w)/2:H-h-${CAPTION_BOTTOM}:shortest=1[${to}]`
}

const parts = cfg.shots.map((s, i) => {
  const out = raw(`s${i}.mp4`)
  if (s.freeze === undefined && s.title) {
    run(['-loop', '1', '-i', bg, '-loop', '1', '-i', raw(`s${i}.title.png`), '-filter_complex',
      `[1:v]format=rgba,fade=t=in:st=0.2:d=0.6:alpha=1[t];[0:v][t]overlay=0:0,format=yuv420p`,
      '-t', String(s.secs), ...enc, out])
    return { out, secs: s.secs }
  }
  if (s.callout) {
    const view = s.view || BASE
    const p = place(view)
    const still = raw(`s${i}.still.png`)
    run(['-ss', String(s.freeze), '-i', src, '-frames:v', '1', '-vf', `${crop(view)},scale=${p.w}:${p.h}:flags=lanczos`, still])
    const spots = (s.highlight || []).flatMap((h) => spotlight(h.rect, view, p, null, null))
    const [cx, cy] = s.callout.at
    run(['-loop', '1', '-i', bg, '-loop', '1', '-i', still, '-loop', '1', '-i', raw(`s${i}.panel.png`),
      '-filter_complex',
      `[0:v][1:v]overlay=${p.x}:${p.y}${spots.length ? ',' + spots.join(',') : ''}[f];` +
      `[2:v]format=rgba,fade=t=in:st=0.3:d=0.4:alpha=1[pn];` +
      `[f][pn]overlay=${cx}:${cy},format=yuv420p`,
      '-t', String(s.secs), ...enc, out])
    return { out, secs: s.secs }
  }
  if (s.freeze !== undefined && s.items) {
    const view = s.view || BASE
    const p = place(view)
    run(['-loop', '1', '-i', bg, '-ss', String(s.freeze), '-i', src, '-loop', '1', '-i', raw(`s${i}.panel.png`),
      '-filter_complex',
      `[1:v]${crop(view)},scale=${p.w}:${p.h}:flags=lanczos,boxblur=6:2,` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.5:t=fill,loop=loop=-1:size=1:start=0,setpts=N/(30*TB)[f];` +
      `[0:v][f]overlay=${p.x}:${p.y}:shortest=1[b];` +
      `[2:v]format=rgba,fade=t=in:st=0.3:d=0.6:alpha=1[pn];` +
      `[b][pn]overlay=(W-w)/2:(H-h)/2,format=yuv420p`,
      '-frames:v', String(Math.round(s.secs * 30)), ...enc, out])
    return { out, secs: s.secs }
  }
  if (s.freeze !== undefined) {
    const view = s.view || BASE
    const p = place(view, FREEZE_BOX)
    const still = raw(`s${i}.still.png`)
    run(['-ss', String(s.freeze), '-i', src, '-frames:v', '1', '-vf', `${crop(view)},scale=${p.w}:${p.h}:flags=lanczos`, still])
    const spots = (s.highlight || []).flatMap((h) => spotlight(h.rect, view, p, null, null))
    // The frame holds, and the panel fades up beside it.
    run(['-loop', '1', '-i', bg, '-loop', '1', '-i', still, '-loop', '1', '-i', raw(`s${i}.panel.png`),
      '-filter_complex',
      `[0:v][1:v]overlay=${p.x}:${p.y}${spots.length ? ',' + spots.join(',') : ''}[f];` +
      `[2:v]format=rgba,fade=t=in:st=0.35:d=0.5:alpha=1[pn];` +
      `[f][pn]overlay=${PANEL_X}:(H-h)/2,format=yuv420p`,
      '-t', String(s.secs), ...enc, out])
    return { out, secs: s.secs }
  }
  const view = s.view || BASE
  const p = place(view)
  const speed = s.speed || 1
  const hl = (s.highlight || []).map((h) => ({ ...h, from: h.from ?? s.from, to: h.to ?? s.to }))
  const holds = hl.filter((h) => h.hold > 0).sort((a, b) => a.from - b.from)
  const at = (t) => (t - s.from) / speed
  // Output time: the sped-up clock plus every hold that starts before t. A
  // spotlight runs through its own hold and ends where the next one begins.
  const shift = (t) => at(t) + holds.filter((h) => h.from < t).reduce((a, h) => a + h.hold, 0)
  const secs = at(s.to) + holds.reduce((a, h) => a + h.hold, 0)
  const spots = hl.flatMap((h) =>
    spotlight(h.rect, view, p, Math.max(0, shift(h.from)), Math.min(secs, shift(h.to))))
  // A hold repeats one frame; applied last-first so each start index is still
  // the frame's position in the unlooped stream, then the clock is rebuilt.
  const loops = holds.slice().reverse().map((h) =>
    `loop=loop=${Math.round(h.hold * 30)}:size=1:start=${Math.round(at(h.from) * 30)}`)
  const retime = loops.length ? ',' + loops.join(',') + ',setpts=N/(30*TB)' : ''
  // The view, sped up, laid on the gradient where place() put it (a view
  // narrower than 16:9 sits centred on it), then the spotlight, then the pill.
  let fc = `[0:v]${crop(view)},scale=${p.w}:${p.h}:flags=lanczos,setsar=1,` +
    `setpts=(PTS-STARTPTS)/${speed},fps=30${retime}[f];` +
    `[1:v][f]overlay=${p.x}:${p.y}:shortest=1${spots.length ? ',' + spots.join(',') : ''}[v]`
  const inputs = ['-ss', String(s.from), '-to', String(s.to), '-i', src, '-loop', '1', '-i', bg]
  let last = 'v'
  if (s.caption) { inputs.push('-loop', '1', '-i', raw(`s${i}.cap.png`)); fc += captionOver(2, secs, 'v', 'vc'); last = 'vc' }
  run([...inputs, '-filter_complex', fc + `;[${last}]format=yuv420p[o]`, '-map', '[o]',
    '-t', secs.toFixed(3), ...enc, out])
  return { out, secs }
})

// ── join ──────────────────────────────────────────────────────────────────
const out = join(DIR, name + '.mp4')
let chain = parts.map((p, i) => `[${i}:v]fps=30,settb=1/30[n${i}];`).join('')
let prev = '[n0]'
let t = 0
parts.slice(1).forEach((p, i) => {
  t += parts[i].secs - FADE
  const tag = i === parts.length - 2 ? '' : `[x${i}]`
  chain += `${prev}[n${i + 1}]xfade=transition=fade:duration=${FADE}:offset=${t.toFixed(3)}${tag};`
  prev = tag
})
run([...parts.flatMap((p) => ['-i', p.out]), '-filter_complex', chain.replace(/;$/, ''),
  '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out])
const total = parts.reduce((a, p) => a + p.secs, 0) - FADE * (parts.length - 1)
console.log(`${name}: ${out} (${total.toFixed(1)}s, ${parts.length} shots)`)
