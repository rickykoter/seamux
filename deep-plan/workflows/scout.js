export const meta = {
  name: 'scout',
  description: 'deep-plan scouts: one read-only agent per open planning question, answers returned in spec shape',
  whenToUse: 'Planning step 3 (scout the uncertainty) and the bug lane (one scout per hypothesis). Args: {questions: [{id, claim, kind: "fact" | "contract" | "hypothesis", falsify}], root}.',
  phases: [{ title: 'Scout', detail: 'one read-only agent per question' }],
}

// Each scout answers one question and cites the lines it read. The script
// writes nothing: it returns candidates for the spec (verifiedFacts, risks,
// contract reach, hypothesis verdicts) for the planning agent to place, and
// render's evidence check still reads every citation. A claim no scout
// confirmed is a risk, never a fact.
//
// args.questions: [{ id, claim, kind, falsify }]
//   fact        a claim about the code: confirmed or refuted from what it reads
//   contract    a surface (table, endpoint, signature): who consumes it
//   hypothesis  a bug lane explanation, with the falsify check that could disprove it
// args.root: the repository the questions are about (the agents' cwd if unset).

const KINDS = ['fact', 'contract', 'hypothesis']
const given = args && Array.isArray(args.questions) ? args.questions : []
const root = args && typeof args.root === 'string' ? args.root : ''
const questions = given.filter(q => q && typeof q.id === 'string' && q.id && typeof q.claim === 'string' && q.claim &&
  KINDS.includes(q.kind) && (q.kind !== 'hypothesis' || (typeof q.falsify === 'string' && q.falsify)))
if (!questions.length) throw new Error('scout: args.questions wants [{id, claim, kind: fact|contract|hypothesis, falsify (hypothesis only)}]')
if (questions.length !== given.length)
  log(`scout: skipped ${given.length - questions.length} malformed question(s) (each needs id, claim, a kind, and falsify for a hypothesis)`)

const ANSWER = {
  type: 'object', required: ['verdict', 'summary', 'evidence'],
  properties: {
    verdict: { enum: ['confirmed', 'refuted', 'unconfirmed'],
               description: 'confirmed or refuted only from lines you read (or a check you ran); unconfirmed otherwise' },
    summary: { type: 'string', description: 'one or two sentences: what you found' },
    evidence: { type: 'array', items: { type: 'object', required: ['path', 'line', 'says'],
      properties: { path: { type: 'string', description: 'repo-relative' }, line: { type: 'integer', minimum: 1 },
                    says: { type: 'string', description: 'what that line shows, in a few words' } } } },
  },
}

const where = root ? ` in the repository at ${root}` : ' in this repository'
const RULES = '\n\nRead the code itself; do not edit any file. Cite every line you rely on as path and line ' +
  '(repo-relative path, a line that exists). If what you read does not settle it, the verdict is unconfirmed: ' +
  'that is a fine answer, a guess is not.'
const PROMPTS = {
  fact: q => `Check one claim${where}:\n\n${q.claim}\n\nconfirmed if the code shows it, refuted if the code shows otherwise.` + RULES,
  contract: q => `Map who uses one contract surface${where}:\n\n${q.claim}\n\nFind every caller, consumer, reader or writer ` +
    '(search by name across languages, configs and tests). confirmed when you found its consumers; list each one in evidence ' +
    'and name them in the summary.' + RULES,
  hypothesis: q => `A bug has competing explanations. Test one${where}:\n\n${q.claim}\n\nRun or perform its falsify check: ` +
    `${q.falsify}\n\nrefuted if the check disproves it, confirmed if the check and the code support it, unconfirmed if the check ` +
    'could not run or did not decide it. Say what the check showed. Commands that only read or run tests are fine.' + RULES,
}
// Explore agents are read-only. A hypothesis's check may need judgment and a
// test run, so it gets the session's model; a fact or a reach is a search.
const OPTS = {
  fact: { agentType: 'Explore', model: 'haiku', effort: 'low' },
  contract: { agentType: 'Explore', model: 'haiku', effort: 'low' },
  hypothesis: { agentType: 'Explore', effort: 'medium' },
}

const cite = e => `${String(e.path || '').replace(/^\.?\//, '')}:${e.line}`
const cited = a => (a && Array.isArray(a.evidence) ? a.evidence : []).filter(e => e && e.path && Number.isInteger(e.line) && e.line > 0)

phase('Scout')
const answers = await parallel(questions.map(q => () =>
  agent(PROMPTS[q.kind](q), { ...OPTS[q.kind], label: `${q.kind} ${q.id}`, phase: 'Scout', schema: ANSWER })))

const out = { verifiedFacts: [], risks: [], contracts: [], hypotheses: [], answers: [] }
questions.forEach((q, i) => {
  const a = answers[i]
  const ev = cited(a)
  out.answers.push({ id: q.id, kind: q.kind, ...(a || { verdict: 'unconfirmed', summary: 'the scout reported nothing', evidence: [] }) })
  const why = a ? a.summary : 'the scout reported nothing'
  if (q.kind === 'hypothesis') {
    // A hypothesis keeps its own lane: open unless the check decided it.
    const verdict = a && ev.length && (a.verdict === 'confirmed' || a.verdict === 'refuted') ? a.verdict : 'open'
    out.hypotheses.push({ id: q.id, claim: q.claim, falsify: q.falsify, verdict,
      evidence: why + (ev.length ? ` (${ev.map(cite).join(', ')})` : '') })
    return
  }
  if (a && a.verdict === 'confirmed' && ev.length) {
    if (q.kind === 'contract') out.contracts.push({ id: q.id, surface: q.claim, reach: why, evidence: ev.map(cite) })
    // One fact per cited line, so render's evidence check reads each.
    else out.verifiedFacts.push({ id: q.id, claim: q.claim, evidence: cite(ev[0]) })
    for (const e of q.kind === 'contract' ? ev.slice(0, 5) : ev.slice(1, 3))
      out.verifiedFacts.push({ id: q.id, claim: q.kind === 'contract' ? `${e.says} (consumer of ${q.claim})` : `${q.claim}: ${e.says}`, evidence: cite(e) })
    return
  }
  // Refuted, unconfirmed, or confirmed with nothing cited: a risk, its
  // disposition the person's to choose.
  const said = a && a.verdict === 'refuted' ? 'refuted' : a && a.verdict === 'confirmed' ? 'confirmed with no line cited' : 'unconfirmed'
  out.risks.push({ id: q.id, risk: `${q.claim} (${said}: ${why})`, ...(ev.length ? { note: ev.map(cite).join(', ') } : {}) })
})
log(`scout: ${out.verifiedFacts.length} fact(s), ${out.contracts.length} contract reach, ${out.hypotheses.length} hypothesis verdict(s), ${out.risks.length} risk(s)`)
return out
