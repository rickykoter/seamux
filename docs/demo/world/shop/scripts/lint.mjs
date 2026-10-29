// The shop's lint: no `var`, no console.log left in src/.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
let bad = 0
const walk = (d) => readdirSync(d).forEach((f) => {
  const p = join(d, f)
  if (statSync(p).isDirectory()) return walk(p)
  readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
    if (/\bvar\s/.test(l) || /console\.log/.test(l)) { console.log(`${p}:${i + 1}: ${l.trim()}`); bad++ }
  })
})
walk('src')
if (bad) { console.log(`${bad} problem(s)`); process.exit(1) }
console.log('lint ok')
