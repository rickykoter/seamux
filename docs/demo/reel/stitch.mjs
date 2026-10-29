#!/usr/bin/env node
// stitch — put every clip on one canvas and join them into the Tour.
//
//   node stitch.mjs                         the default running order, from --out
//   node stitch.mjs board plan usage        a different order or subset
//   node stitch.mjs --out DIR               where the clips are (~/Movies/seamux-reel)
//   node stitch.mjs a b --line "…" --to x.mp4   another title line, another output file
//
// A name is <name>.mp4 in DIR. testreel's clips are bare windows (record.mjs
// turns its background off) and the terminal clip is a full-display cmux-cua
// capture, so the frame is applied HERE, the same way for both: each clip is
// cropped and trimmed (terminal only: <name>.crop holds `w:h:x:y` in video
// pixels, <name>.trim holds `start end` in seconds), scaled
// down to fit, given rounded corners, and centred on one gradient. Without that
// the cut from the terminal to the board is a jump between two different looks.
//
// Words come from cards.mjs: a title card opens the Tour, and each clip's
// <name>.captions.json ([{at, text}], seconds on the clip's own untrimmed clock;
// record.mjs writes them, the terminal's is written by hand) puts a caption
// over each beat until the next one.
//
// Output: DIR/tour.mp4, 1920x1080, H.264, short crossfades between clips.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import ffmpeg from 'ffmpeg-static'
import { renderCards } from './cards.mjs'

const W = 1920
const H = 1080
const MARGIN = 72         // minimum space around the window, every side
const RADIUS = 14
const FADE = 0.45         // seconds of crossfade between clips
const TITLE_SECS = 3.4
const CAPTION_FADE = 0.3
const CAPTION_BOTTOM = 34 // px from the canvas bottom to the caption's bottom edge
const BG = { from: [30, 35, 38], to: [58, 77, 69] }   // #1e2326 → #3a4d45
export const ORDER = ['terminal', 'board', 'plan', 'parent', 'family', 'famboard', 'usage']

const argv = process.argv.slice(2)
const outAt = argv.indexOf('--out')
const DIR = outAt >= 0 ? argv[outAt + 1] : join(homedir(), 'Movies', 'seamux-reel')
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }
const LINE = flag('--line')        // the title card's line (default: the Tour's)
const TO = flag('--to') || 'tour.mp4'
const valued = new Set(['--out', '--line', '--to'])
const names = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]))

function run(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' '))
}

// ffmpeg-static ships no ffprobe; `ffmpeg -i` prints what we need on stderr.
function probe(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr)
  const s = /Video: .*?, (\d{2,5})x(\d{2,5})/.exec(r.stderr)
  if (!d || !s) throw new Error('cannot read ' + file)
  return { secs: +d[1] * 3600 + +d[2] * 60 + +d[3], w: +s[1], h: +s[2] }
}

const even = (n) => Math.max(2, Math.floor(n / 2) * 2)

// One clip → a 1920x1080 30fps segment on the shared background.
function captionsFor(name) {
  const f = join(DIR, name + '.captions.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []
}

const capPng = (name, i) => join(DIR, '.raw', `${name}.cap${i}.png`)

// Each caption holds until the next one, and the last until the crossfade out.
function captionChain(name, from, secs, firstInput) {
  const caps = captionsFor(name)
  let inputs = []
  let chain = ''
  let prev = '[framed]'
  caps.forEach((c, i) => {
    const st = Math.max(0.3, c.at - from)
    const end = Math.min(secs - FADE, i + 1 < caps.length ? caps[i + 1].at - from : secs - FADE)
    if (end - st < 0.8) return
    const n = firstInput + inputs.length / 4
    inputs.push('-loop', '1', '-i', capPng(name, i))
    const tag = `[c${i}]`
    chain += `;[${n}:v]format=rgba,fade=t=in:st=${st.toFixed(2)}:d=${CAPTION_FADE}:alpha=1,` +
      `fade=t=out:st=${(end - CAPTION_FADE).toFixed(2)}:d=${CAPTION_FADE}:alpha=1${tag}` +
      `;${prev}${tag}overlay=(W-w)/2:H-h-${CAPTION_BOTTOM}:enable='between(t,${st.toFixed(2)},${end.toFixed(2)})'[o${i}]`
    prev = `[o${i}]`
  })
  return { inputs, chain, last: prev }
}

function frame(name, bg) {
  const src = join(DIR, name + '.mp4')
  if (!existsSync(src)) throw new Error(`missing ${src} — record it first (see take.md)`)
  const cropFile = join(DIR, name + '.crop')
  const crop = existsSync(cropFile) ? readFileSync(cropFile, 'utf8').trim() : ''
  let { w, h, secs } = probe(src)
  if (crop) [w, h] = crop.split(':').map(Number)
  const trimFile = join(DIR, name + '.trim')
  const [from, to] = existsSync(trimFile)
    ? readFileSync(trimFile, 'utf8').trim().split(/\s+/).map(Number)
    : [0, secs]
  secs = to - from
  const k = Math.min(1, (W - 2 * MARGIN) / w, (H - 2 * MARGIN) / h)
  const sw = even(w * k)
  const sh = even(h * k)
  // Alpha mask: opaque inside a rounded rectangle, built once as one frame.
  const mask = join(DIR, '.raw', `${name}.mask.png`)
  const r = RADIUS
  run(['-f', 'lavfi', '-i', `color=black:s=${sw}x${sh},format=gray`, '-frames:v', '1', '-vf',
    `geq=lum='255*lte(hypot(max(0,max(${r}-X,X-(W-1-${r}))),max(0,max(${r}-Y,Y-(H-1-${r})))),${r})'`,
    mask])
  const out = join(DIR, '.raw', `${name}.framed.mp4`)
  const pre = (crop ? `crop=${crop},` : '') + `scale=${sw}:${sh}:flags=lanczos,fps=30,format=yuva420p`
  const caps = captionChain(name, from, secs, 3)
  run(['-ss', String(from), '-to', String(to), '-i', src, '-loop', '1', '-i', mask, '-loop', '1', '-i', bg,
    ...caps.inputs, '-filter_complex',
    `[0:v]${pre}[v];[1:v]format=gray[m];[v][m]alphamerge[win];` +
    `[2:v]format=yuv420p[bg];[bg][win]overlay=(W-w)/2:(H-h)/2:shortest=1[framed]` +
    caps.chain + `;${caps.last}format=yuv420p`,
    // -t: the looped mask and background never end, and alphamerge does not stop
    // at its shorter input, so without it this encodes forever.
    '-t', secs.toFixed(3), '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', out])
  return { out, secs: probe(out).secs }
}

// The opening card: the title fades up on the same background as the clips.
function titleSegment(bg) {
  const png = join(DIR, '.raw', 'title.png')
  const out = join(DIR, '.raw', 'title.framed.mp4')
  run(['-loop', '1', '-i', bg, '-loop', '1', '-i', png, '-filter_complex',
    `[1:v]format=rgba,fade=t=in:st=0.2:d=0.7:alpha=1[t];[0:v][t]overlay=0:0,fps=30,format=yuv420p`,
    '-t', String(TITLE_SECS), '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', out])
  return { out, secs: TITLE_SECS }
}

async function main() {
  const list = names.length ? names : ORDER.filter((n) => existsSync(join(DIR, n + '.mp4')))
  if (!list.length) throw new Error(`no clips in ${DIR}`)
  await renderCards([
    { kind: 'title', out: join(DIR, '.raw', 'title.png'), title: LINE ? { name: 'seamux', line: LINE } : undefined },
    ...list.flatMap((n) => captionsFor(n).map((c, i) => ({ kind: 'caption', text: c.text, out: capPng(n, i) }))),
  ])
  const [a, b] = [BG.from, BG.to]
  const bg = join(DIR, '.raw', 'background.png')
  const lerp = (i) => `${a[i]}+(${b[i] - a[i]})*(X+Y)/(W+H)`
  run(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}`, '-frames:v', '1', '-vf',
    `format=rgb24,geq=r='${lerp(0)}':g='${lerp(1)}':b='${lerp(2)}'`, bg])

  const parts = [titleSegment(bg), ...list.map((n) => {
    const f = frame(n, bg)
    console.log(`framed ${n} (${f.secs.toFixed(1)}s, ${captionsFor(n).length} captions)`)
    return f
  })]
  const out = join(DIR, TO)
  if (parts.length === 1) {
    execFileSync('cp', [parts[0].out, out])
  } else {
    // xfade needs one frame rate and timebase on both sides; the segments don't
    // agree (the looped stills set the rate), so every input is normalized first.
    // Offsets are measured on the output timeline, which each fade shortens.
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
      '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', out])
  }
  console.log(`tour: ${out} (${probe(out).secs.toFixed(1)}s, ${list.join(' → ')})`)
}

await main()
