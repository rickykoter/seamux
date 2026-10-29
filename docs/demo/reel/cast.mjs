// cast — terminal scenes as data: real command output plus scripted lines.
//
// A scene is a list of beats. Each becomes chunks of {t, d} (seconds, bytes)
// that term.html plays back:
//
//   { run: 'deep-plan grade x q1=a', cwd, env }  typed at the prompt, then run
//                                                 for real under a pty (`script`)
//                                                 and its output pasted in
//   { type: '> Plan the share links' }            typed, nothing run (a user line)
//   { say: 'text', color }                        printed, as an agent's line
//   { out: 'raw text' }                           printed as is
//   { wait: 1.2 }                                 a pause
//   { clear: true }
//   { cue: 'Cue card text' }                     a caption from this moment on
//   { fn: () => … }                               runs while building, films nothing
//
// build() returns { chunks, cues, secs }. Commands and agents run while the cast
// is built, before anything is filmed, so a slow model costs no screen time.
//
// Output is scrubbed before it is filmed: the demo home, the temp root and the
// user name become neutral paths, so nothing of this machine shows.

import { spawnSync } from 'node:child_process'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'

const ESC = '\x1b['
export const C = {
  b: ESC + '1m', d: ESC + '2m', r: ESC + '0m',
  or: ESC + '38;5;173m', rd: ESC + '38;5;167m', gn: ESC + '38;5;108m', yl: ESC + '38;5;179m',
}
export const PROMPT = `${C.gn}~/shop${C.r} ${C.or}❯${C.r} `

export function scrubber(pairs) {
  const me = userInfo().username
  const host = hostname()
  const list = [...pairs, [tmpdir().replace(/\/$/, ''), '/tmp'], [homedir(), '~'], [`/private/tmp`, '/tmp'], [host, 'laptop'], [host.split('.')[0], 'laptop'], [me, 'sam']]
  return (s) => list.reduce((acc, [a, b]) => (a ? acc.split(a).join(b) : acc), s)
}

export function build(beats, { scrub = (s) => s, prompt = PROMPT, cps = 38 } = {}) {
  const out = []
  const cues = []
  let t = 0.4
  const emit = (d, dt = 0) => { out.push({ t: +t.toFixed(3), d }); t += dt }
  const typeOut = (s) => { for (const ch of s) emit(ch, 1 / cps) }
  for (const b of beats) {
    if (b.cue) { cues.push({ at: +t.toFixed(2), text: b.cue }); continue }
    if (b.fn) { b.fn(); continue }
    if (b.wait) t += b.wait
    else if (b.clear) emit('\x1b[2J\x1b[H')
    else if (b.out) emit(scrub(b.out).replace(/\n/g, '\r\n'), 0.25)
    else if (b.say) {
      const lines = b.say.split('\n')
      lines.forEach((l, i) => emit((i ? '  ' : `${C.or}⏺${C.r} `) + (b.color || '') + l + C.r + '\r\n', 0.12))
      t += 0.5
    } else if (b.type) {
      emit(`${C.b}`)
      typeOut(b.type)
      emit(`${C.r}\r\n\r\n`, 0.6)
    } else if (b.agent) {
      // A live Claude turn: the prompt is typed as the user's line, then the
      // model's text and tool calls are drawn the way Claude Code draws them.
      emit(`${C.b}> `); typeOut(b.shown || b.agent); emit(`${C.r}\r\n\r\n`, 0.5)
      const events = runAgent(b)
      if (b.onResult) b.onResult(events)
      for (const line of agentLines(events, { ...b, scrub })) emit(line + '\r\n', b.lineDelay ?? 0.16)
      emit('\r\n', b.hold ?? 3.5)
    } else if (b.run) {
      emit(b.bare ? '' : b.where ? `${C.gn}${b.where}${C.r} ${C.or}❯${C.r} ` : prompt, 0.3)
      typeOut(b.shown || b.run)
      emit('\r\n', 0.35)
      const r = spawnSync('script', ['-q', '/dev/null', '/bin/bash', '-c', b.run], {
        cwd: b.cwd, env: { ...process.env, ...b.env, TERM: 'xterm-256color' }, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], // script needs no tty on stdin, but refuses a socket
      })
      let text = (r.stdout || '') + (r.stderr || '')
      text = text.replace(/^\^D\x08\x08/, '').replace(/\r?\n/g, '\n').replace(/\n+$/, '')
      if (b.filter) text = b.filter(text)
      if (b.expect !== undefined && r.status !== b.expect) {
        throw new Error(`"${b.run}" exited ${r.status}, expected ${b.expect}:\n${text}`)
      }
      for (const line of scrub(text).split('\n')) emit(line + '\r\n', b.lineDelay ?? 0.06)
      emit('\r\n', b.hold ?? 2.6)
    }
  }
  emit(prompt, 1.5)
  return { chunks: out, cues, secs: t }
}

// ── live agent turns ──────────────────────────────────────────────────────

// The variables the demo world sets for the engines. The outer `claude` runs
// without them: exported, they would also reach the installed plugins' hooks,
// which would then act on the demo state. Only the --settings hook wrappers
// (hooks.json in the world) carry them, so the hooks that fire are this
// checkout's, on the throwaway plan.
const WORLD_VARS = /^(DEEP_PLAN_|LOOKOUT_|RESTACK_|SEAMUX_HOST$)/

export function runAgent(b) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !WORLD_VARS.test(k)))
  if (env.DEMO) env.PATH = `${env.DEMO}/agentbin:${env.PATH}`
  const args = ['-p', '--model', b.model || 'sonnet', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--permission-mode', b.mode || 'acceptEdits']
  if (b.effort) args.push('--effort', b.effort)
  if (b.settings) args.push('--settings', b.settings)
  if (b.tools) args.push('--allowedTools', b.tools)
  if (b.system) args.push('--append-system-prompt', b.system)
  const r = spawnSync('claude', args, { cwd: b.cwd, env, input: b.agent, encoding: 'utf8',
    maxBuffer: 64 << 20, timeout: (b.timeout || 300) * 1000 })
  const events = (r.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const res = events.find((e) => e.type === 'result')
  if (!res) throw new Error(`claude gave no result (exit ${r.status}): ${(r.stderr || '').slice(0, 800)}`)
  if (b.expect && !b.expect(events)) {
    throw new Error(`agent beat failed its check: ${b.agent.slice(0, 80)}\n${finalText(events).slice(0, 1200)}`)
  }
  return events
}

export const finalText = (events) => events.find((e) => e.type === 'result')?.result || ''
export const toolUses = (events) => events.filter((e) => e.type === 'assistant')
  .flatMap((e) => e.message.content.filter((c) => c.type === 'tool_use'))
export const toolResults = (events) => events.filter((e) => e.type === 'user')
  .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []).filter((c) => c.type === 'tool_result'))

function wrap(text, width) {
  const out = []
  for (const para of text.split('\n')) {
    if (!para.trim()) { out.push(''); continue }
    const lead = /^(\s*(?:[-*]|\d+\.)\s+)/.exec(para)?.[1] || ''
    let line = ''
    for (const w of para.split(/\s+/)) {
      if (line && (line + ' ' + w).length > width) { out.push(line); line = ' '.repeat(lead.length) + w }
      else line = line ? line + ' ' + w : w
    }
    out.push(line)
  }
  return out
}

const md = (s) => s.replace(/\*\*(.+?)\*\*/g, `${C.b}$1${C.r}`).replace(/`([^`]+)`/g, `${C.yl}$1${C.r}`)

function toolLabel(t, root) {
  const i = t.input || {}
  const rel = (p) => (root && p?.startsWith(root + '/') ? p.slice(root.length + 1) : p)
  if (i.file_path) return `${t.name}(${rel(i.file_path)})`
  if (i.command) return `Bash(${i.command.split("\n")[0].slice(0, 88)})`
  if (i.pattern) return `${t.name}(${i.pattern})`
  if (i.skill) return `Skill(${i.skill})`
  return t.name
}

function resultText(c) {
  const t = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : String(c.content || '')
  return t.replace(/<\/?tool_use_error>/g, '').replace(/^\w+:\w+ hook error: \[[^\]]*\]:\s*/, '').trim()
}

// Claude Code's look: ⏺ before each text block and tool call, ⎿ under a
// call for its result, a refused call in red.
export function agentLines(events, { width = 96, cwd, resultLines = 2, scrub = (x) => x } = {}) {
  const results = new Map(toolResults(events).map((c) => [c.tool_use_id, c]))
  const lines = []
  for (const e of events) {
    if (e.type !== 'assistant') continue
    for (const c of e.message.content) {
      if (c.type === 'text' && c.text.trim()) {
        wrap(scrub(c.text.trim()), width).forEach((l, i) => lines.push((i ? '  ' : `${C.or}⏺${C.r} `) + md(l)))
        lines.push('')
      } else if (c.type === 'tool_use') {
        if (c.name === 'TodoWrite') continue
        lines.push(`${C.gn}⏺${C.r} ${C.b}${scrub(toolLabel(c, cwd))}${C.r}`)
        const r = results.get(c.id)
        if (r) {
          const body = scrub(resultText(r)).split('\n').filter((l) => l.trim())
          const color = r.is_error ? C.rd : C.d
          const shown = body.slice(0, r.is_error ? 4 : resultLines)
          shown.forEach((l, i) => lines.push(`  ${i ? '   ' : '⎿  '}${color}${l.slice(0, width)}${C.r}`))
          if (body.length > shown.length) lines.push(`     ${C.d}… +${body.length - shown.length} lines${C.r}`)
        }
        lines.push('')
      }
    }
  }
  return lines
}
