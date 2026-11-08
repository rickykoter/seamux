export const meta = { name: 'spike-wf', description: 'tiny spike', phases: [{ title: 'Say' }] }
const r = await parallel([0,1].map(i => () => agent('Reply with exactly the JSON {"score": ' + (i+7) + '} and nothing else.', { label: 'judge ' + i, phase: 'Say', model: 'haiku' })))
return { results: r }