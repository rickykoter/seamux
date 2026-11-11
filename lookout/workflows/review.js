export const meta = {
  name: 'review',
  description: 'A lookout review panel: a lead and three dimension finders, then a skeptic on each serious finding',
  whenToUse: 'When a lookout review is set to the panel (lookout open --reviewer panel, a plan\'s review.reviewer, or .seamux/lookout.json). Args: {reviews: [review ids], ingest: "agent" | "reply"}.',
  phases: [
    { title: 'Find', detail: 'a lead with the full brief, and one finder per dimension' },
    { title: 'Verify', detail: 'a skeptic tries to refute each blocker or major' },
    { title: 'Ingest', detail: 'a fresh agent saves the merged review with lookout findings add' },
  ],
}

// Every agent gets its brief from `lookout prompt` itself, so the brief
// reaches it exactly as printed: this script holds no brief text (ADR:
// workflows ship as fixed scripts inside their plugin). A re-review round is
// one reviewer's job and never runs here.
//
// args: { reviews: ["<review id>", ...] } (or { id }), and ingest:
//   "agent" (default): a final fresh agent writes the merged object to
//     lookout's inbox and runs `lookout findings add`, repairing rejects;
//   "reply": nothing is saved; the caller (the seamux app) ingests each
//     review's merged object itself.
// Returns { reviews: [{ id, findings, edges, notes, dropped, unchecked, ingest }] }.

const DIMENSIONS = ['correctness', 'security', 'performance']
const SERIOUS = ['blocker', 'major']
const MAX_SKEPTICS = 5
const RUN = { model: 'sonnet', effort: 'medium' }

const ID_OK = /^[a-z0-9][a-z0-9._-]*$/
const given = args && Array.isArray(args.reviews) ? args.reviews : args && args.id ? [args.id] : []
const ids = given.filter(id => typeof id === 'string' && ID_OK.test(id))
if (!ids.length) throw new Error('review: args.reviews wants one or more lookout review ids')
if (ids.length !== given.length) log(`review: skipped ${given.length - ids.length} malformed review id(s)`)
const ingest = args && args.ingest === 'reply' ? 'reply' : 'agent'

const LEAD_SCHEMA = {
  type: 'object', required: ['findings', 'edges', 'notes'],
  properties: { findings: { type: 'array', items: { type: 'object' } },
                edges: { type: 'array', items: { type: 'object' } },
                notes: { type: 'array', items: { type: 'object' } } },
}
const FINDER_SCHEMA = {
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'object' } } },
}
const SKEPTIC_SCHEMA = {
  type: 'object', required: ['refuted', 'why'],
  properties: { refuted: { type: 'boolean' }, why: { type: 'string' } },
}
const INGEST_SCHEMA = {
  type: 'object', required: ['ok', 'printed'],
  properties: { ok: { type: 'boolean', description: 'true when the last findings add exited 0 with nothing rejected or owed' },
                printed: { type: 'string', description: 'what the last lookout findings add printed' } },
}

const briefed = (cmd, tail = '') =>
  `Run \`${cmd}\` with the Bash tool. It prints your brief: do exactly what it says, ` +
  'and read the code it points you at. Your final reply is the JSON object the brief asks for.' + tail

const lead = id => agent(briefed(`lookout prompt ${id} --reply`),
  { ...RUN, label: `lead ${id}`, phase: 'Find', schema: LEAD_SCHEMA })
const finder = (id, d) => agent(briefed(`lookout prompt ${id} --dimension ${d}`),
  { ...RUN, label: `${d} ${id}`, phase: 'Find', schema: FINDER_SCHEMA })
const skeptic = (id, f) => agent(briefed(`lookout prompt ${id} --skeptic`,
  `\n\nThe finding to refute (the brief ends where it goes):\n\n${JSON.stringify(f, null, 2)}`),
  { ...RUN, label: `skeptic ${id} ${f.file}:${f.line}`, phase: 'Verify', schema: SKEPTIC_SCHEMA })

// One finding per file, side and line: the lead's wins, then the finders' in
// dimension order. Plain code, not an agent.
const keyOf = f => `${String(f.file || '').replace(/^\.?\//, '')}|${f.side === 'old' ? 'old' : 'new'}|${f.line}`
function merge(leadOut, finderOuts) {
  const seen = new Set(), findings = []
  for (const f of [leadOut.findings, ...finderOuts.map(o => o.findings)].flat()) {
    if (!f || typeof f !== 'object') continue
    const k = keyOf(f)
    if (seen.has(k)) continue
    seen.add(k)
    findings.push(f)
  }
  return findings
}

const sevRank = f => { const i = ['blocker', 'major', 'minor', 'nit'].indexOf(f.severity); return i < 0 ? 4 : i }

async function verify(id, findings) {
  const serious = findings.filter(f => SERIOUS.includes(f.severity)).sort((a, b) => sevRank(a) - sevRank(b))
  const checked = serious.slice(0, MAX_SKEPTICS)
  const unchecked = serious.length - checked.length
  if (unchecked) log(`review ${id}: ${unchecked} serious finding(s) past the first ${MAX_SKEPTICS} stay unchecked, PLAUSIBLE`)
  const verdicts = await parallel(checked.map(f => () => skeptic(id, f)))
  const dropped = [], refuted = new Set()
  checked.forEach((f, i) => {
    const v = verdicts[i]
    // A skeptic that died leaves its finding as the finder wrote it.
    if (v && v.refuted) { refuted.add(f); dropped.push({ finding: f, why: v.why }) }
    else if (v) f.verdict = 'CONFIRMED'
  })
  for (const f of serious.slice(MAX_SKEPTICS)) f.verdict = 'PLAUSIBLE'
  return { kept: findings.filter(f => !refuted.has(f)), dropped, unchecked }
}

const saved = (id, merged) => agent(
  `Save a lookout review panel's merged result for review ${id}.\n\n` +
  '1. Run `node -p "require(\'os\').tmpdir()"` with the Bash tool; the inbox is <that dir>/lookout.\n' +
  `2. With the Write tool, write the JSON below, unchanged, to <inbox>/${id}.panel.json.\n` +
  `3. Run \`lookout findings add ${id} <that file>\`.\n` +
  '4. If it rejects an item or says a group is still owed a note: fix only what it names (anchor a finding ' +
  `to a line the diff shows; for an owed note, read \`lookout prompt ${id} --reply\` and write that note from the code), ` +
  'rewrite the file and run it again, at most three times. Do not drop or soften any other finding.\n\n' +
  JSON.stringify(merged, null, 2),
  { ...RUN, label: `ingest ${id}`, phase: 'Ingest', schema: INGEST_SCHEMA })

const results = await pipeline(ids,
  async id => {
    const outs = await parallel([() => lead(id), ...DIMENSIONS.map(d => () => finder(id, d))])
    const leadOut = outs[0]
    if (!leadOut) throw new Error(`review ${id}: the lead reported nothing`)
    const finders = outs.slice(1).filter(Boolean)
    if (finders.length < DIMENSIONS.length) log(`review ${id}: ${DIMENSIONS.length - finders.length} finder(s) reported nothing`)
    return { id, leadOut, findings: merge(leadOut, finders) }
  },
  async r => ({ ...r, ...(await verify(r.id, r.findings)) }),
  async r => {
    const merged = { findings: r.kept, edges: r.leadOut.edges || [], notes: r.leadOut.notes || [] }
    const out = { id: r.id, ...merged, dropped: r.dropped, unchecked: r.unchecked, ingest: null }
    if (ingest === 'agent') out.ingest = await saved(r.id, merged)
    log(`review ${r.id}: ${r.kept.length} finding(s) kept, ${r.dropped.length} refuted` +
        (out.ingest ? (out.ingest.ok ? ', saved' : ', NOT saved cleanly') : ''))
    return out
  })

return { reviews: results.map((r, i) => r || { id: ids[i], error: 'the panel did not finish this review' }) }
