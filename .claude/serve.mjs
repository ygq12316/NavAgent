import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

const root = process.cwd()
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let p = decodeURIComponent(url.pathname)
  if (p === '/') p = '/tools/agent-loop-flow.html'
  try {
    const data = await readFile(join(root, p))
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(Number(process.env.PORT) || 8931, '127.0.0.1', () => console.log('serving on http://127.0.0.1:' + (Number(process.env.PORT) || 8931)))
