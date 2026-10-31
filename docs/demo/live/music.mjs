// music — the demo's soundtrack, synthesized: a calm pad, a sub bass, a soft
// pulse and a light arpeggio, all on one 96 BPM grid counted from sample 0.
//
//   node music.mjs OUT.wav SECONDS [accents.json]
//
// accents.json (optional): [seconds, ...] where a cut lands; each gets a soft
// chime in key, quantized to the nearest eighth note. Polished and quiet:
// the music sits under the picture, nothing spiky.
import { writeFileSync, readFileSync } from 'node:fs'

const [out, secsArg, accentsFile] = process.argv.slice(2)
if (!out || !secsArg) { console.error('usage: node music.mjs OUT.wav SECONDS [accents.json]'); process.exit(2) }
const SR = 48000
const SECS = Number(secsArg)
const N = Math.ceil(SECS * SR)
export const BPM = 96
const BEAT = 60 / BPM
const BAR = BEAT * 4
const L = new Float32Array(N), R = new Float32Array(N)

const hz = (m) => 440 * 2 ** ((m - 69) / 12)
// D minor, warm: Dm9 – Bbmaj7 – Fadd9 – C6sus, two bars each.
const CHORDS = [
  { root: 38, notes: [50, 53, 57, 60, 64] },
  { root: 34, notes: [46, 50, 53, 57, 62] },
  { root: 41, notes: [53, 57, 60, 64, 67] },
  { root: 36, notes: [48, 55, 57, 60, 62] },
]
const chordAt = (t) => CHORDS[Math.floor(t / (BAR * 2)) % CHORDS.length]

// A deterministic noise source, so every render is the same.
let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1

function add(buf, i, v) { if (i >= 0 && i < N) buf[i] += v }

// Pad: detuned sines with soft attack/release per chord, slow tremolo.
for (let c = 0; c * BAR * 2 < SECS; c++) {
  const t0 = c * BAR * 2, ch = CHORDS[c % CHORDS.length], len = BAR * 2
  const s0 = Math.floor(t0 * SR), s1 = Math.min(N, Math.floor((t0 + len + 1.2) * SR))
  ch.notes.forEach((m, k) => {
    for (const det of [-0.07, 0.07]) {
      const f = hz(m + det), pan = k % 2 ? 0.35 : -0.35
      for (let i = s0; i < s1; i++) {
        const t = (i - s0) / SR
        const env = Math.min(1, t / 1.1) * (t > len ? Math.max(0, 1 - (t - len) / 1.2) : 1)
        const v = 0.016 * env * (Math.sin(2 * Math.PI * f * t) + 0.18 * Math.sin(4 * Math.PI * f * t)) * (0.85 + 0.15 * Math.sin(2 * Math.PI * 0.2 * t))
        add(L, i, v * (1 - pan)); add(R, i, v * (1 + pan))
      }
    }
  })
}

// Sub bass: the root on beats 1 and 3, round and short.
for (let b = 0; b * BEAT < SECS; b++) {
  if (b % 2) continue
  const t0 = b * BEAT, f = hz(chordAt(t0).root), s0 = Math.floor(t0 * SR)
  for (let i = 0; i < SR * BEAT * 1.6; i++) {
    const t = i / SR, env = Math.min(1, t / 0.01) * Math.exp(-t * 2.2)
    const v = 0.11 * env * Math.sin(2 * Math.PI * f * t)
    add(L, s0 + i, v); add(R, s0 + i, v)
  }
}

// Pulse: a soft kick on 1 and 3, a brushed hat on the off-beats, from bar 3.
for (let b = 8; b * BEAT < SECS; b++) {
  const s0 = Math.floor(b * BEAT * SR)
  if (b % 2 === 0) {
    for (let i = 0; i < SR * 0.35; i++) {
      const t = i / SR, f = 48 + 70 * Math.exp(-t * 30)
      const v = 0.16 * Math.exp(-t * 9) * Math.sin(2 * Math.PI * f * t)
      add(L, s0 + i, v); add(R, s0 + i, v)
    }
  }
  const h0 = Math.floor((b + 0.5) * BEAT * SR)
  let lp = 0
  for (let i = 0; i < SR * 0.06; i++) {
    const t = i / SR, n = rnd(); const hp = n - lp; lp = n * 0.6 + lp * 0.4
    const v = 0.012 * Math.exp(-t * 70) * hp
    add(L, h0 + i, v * 0.8); add(R, h0 + i, v * 1.2)
  }
}

// Arpeggio: chord tones an octave up, on eighths, from bar 5, gently panned.
for (let e = 32; e * BEAT / 2 < SECS - BAR; e++) {
  const t0 = e * BEAT / 2, ch = chordAt(t0), m = ch.notes[[0, 2, 4, 3, 1, 3, 2, 4][e % 8]] + 12
  const f = hz(m), s0 = Math.floor(t0 * SR), pan = Math.sin(e * 0.7) * 0.5
  for (let i = 0; i < SR * 0.5; i++) {
    const t = i / SR, env = Math.min(1, t / 0.004) * Math.exp(-t * 7)
    const v = 0.022 * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(6 * Math.PI * f * t) * Math.exp(-t * 20))
    add(L, s0 + i, v * (1 - pan)); add(R, s0 + i, v * (1 + pan))
  }
}

// Accents: a soft bell on each cut, in the chord, on the grid.
const accents = accentsFile ? JSON.parse(readFileSync(accentsFile, 'utf8')) : []
for (const a of accents) {
  const t0 = Math.round(a / (BEAT / 2)) * (BEAT / 2), ch = chordAt(t0)
  const f = hz(ch.notes[2] + 24), s0 = Math.floor(t0 * SR)
  for (let i = 0; i < SR * 1.6; i++) {
    const t = i / SR, env = Math.min(1, t / 0.003) * Math.exp(-t * 3.2)
    const v = 0.03 * env * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 6))
    add(L, s0 + i, v); add(R, s0 + i, v)
  }
}

// A simple stereo room: two short feedback delays, mixed low.
for (const [buf, d] of [[L, 0.0371], [R, 0.0433]]) {
  const D = Math.floor(d * SR), copy = Float32Array.from(buf)
  for (let i = D; i < N; i++) copy[i] += copy[i - D] * 0.42
  for (let i = 0; i < N; i++) buf[i] = buf[i] * 0.8 + copy[i] * 0.2
}

// Master: fade in 1.5s, fade out 3s, soft clip, normalize to -1 dBFS peak.
let peak = 0
for (let i = 0; i < N; i++) {
  const t = i / SR, g = Math.min(1, t / 1.5) * Math.min(1, (SECS - t) / 3)
  L[i] = Math.tanh(L[i] * g * 1.4); R[i] = Math.tanh(R[i] * g * 1.4)
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
}
const norm = peak ? 0.89 / peak : 1
const data = Buffer.alloc(N * 4)
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm)) * 32767), i * 4)
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm)) * 32767), i * 4 + 2)
}
const h = Buffer.alloc(44)
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24)
h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
writeFileSync(out, Buffer.concat([h, data]))
console.log(`music: ${out} (${SECS}s, ${BPM} bpm, ${accents.length} accents)`)
