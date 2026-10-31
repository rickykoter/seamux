// A static server for the shop's pages, on 127.0.0.1:4173.
//   node scripts/serve.mjs          serve in the foreground
//   node scripts/serve.mjs --bg     start it in the background if it isn't up,
//                                   wait until it answers, print its URL
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, normalize } from 'node:path'

const PORT = 4173
const URL = `http://127.0.0.1:${PORT}/web/checkout.html`
const up = () => fetch(URL).then((r) => r.ok, () => false)

if (process.argv.includes('--bg')) {
  if (!(await up())) {
    spawn(process.execPath, [process.argv[1]], { detached: true, stdio: 'ignore' }).unref()
    for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100))
  }
  if (!(await up())) { console.error('serve: the shop did not start'); process.exit(1) }
  console.log(URL)
} else {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
  createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new globalThis.URL(req.url, URL).pathname)).replace(/^\/+/, '')
    if (path.startsWith('..')) { res.writeHead(403).end(); return }
    try {
      const body = await readFile(join(process.cwd(), path))
      res.writeHead(200, { 'content-type': types[extname(path)] || 'text/plain' }).end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  }).listen(PORT, '127.0.0.1')
}
