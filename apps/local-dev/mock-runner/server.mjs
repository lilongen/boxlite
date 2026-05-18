// Mock runner — satisfies just enough of apps/libs/runner-api-client to drive
// the snapshot.manager state machine through PENDING -> PULLING -> ACTIVE and
// let the API observe sandbox state transitions. NOT a real runner; it does
// not actually pull anything. Suitable only for local routing verification.
//
// Real endpoints (apps/runner/...) are at apps/libs/runner-api-client/src/api/.
// We mock only what the API hits during sandbox creation from an image ref.
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT) || 3003

const sha256 = (s) => {
  // Stable 64-hex digest from a string. Real digest is sha256 of the manifest;
  // we don't need real, just deterministic + valid-looking.
  let h = 0n
  for (const c of s) h = (h * 31n + BigInt(c.charCodeAt(0))) & 0xffffffffffffffffn
  const hex = h.toString(16).padStart(16, '0')
  return (hex + hex + hex + hex).slice(0, 64)
}

// In-memory state: which snapshot refs have been "pulled".
const pulled = new Set()

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  const method = req.method

  // --- runner identity ---------------------------------------------------
  if (path === '/' || path === '/info') {
    return send(res, 200, {
      version: 'mock-0.0.1',
      cpu: { cores: 4, usage: 0 },
      memory: { total: 16, used: 0 },
      disk: { total: 100, used: 0 },
      services: { runner: 'ok' },
    })
  }

  // --- snapshot endpoints ------------------------------------------------
  // Inspect registry: returns digest+size so snapshot.manager can compute ref.
  if (method === 'POST' && path === '/snapshots/inspect') {
    const body = await readBody(req)
    const imageName = body?.image || body?.imageName || 'unknown'
    return send(res, 200, { hash: `sha256:${sha256(imageName)}`, sizeGB: 0.01 })
  }

  // Pull request: fire-and-forget; we'll report "exists" on next /info call.
  if (method === 'POST' && path === '/snapshots/pull') {
    const body = await readBody(req)
    const ref = body?.snapshot || body?.snapshotRef || body?.ref
    if (ref) pulled.add(ref)
    console.log(`[mock-runner] pull queued: ${ref}`)
    return send(res, 202, { ok: true })
  }

  // Build is intentionally not supported — confirms our fix routes to pull.
  if (method === 'POST' && path === '/snapshots/build') {
    return send(res, 501, { error: 'mock-runner does not implement build' })
  }

  if (method === 'POST' && path === '/snapshots/info') {
    const body = await readBody(req)
    const ref = body?.snapshot || body?.snapshotRef || body?.ref
    if (pulled.has(ref)) {
      return send(res, 200, { state: 'ready', size: 10 * 1024 * 1024 })
    }
    return send(res, 404, { error: 'not found' })
  }

  if (method === 'POST' && path === '/snapshots/exists') {
    const body = await readBody(req)
    const ref = body?.snapshot || body?.snapshotRef || body?.ref
    return send(res, 200, { exists: pulled.has(ref) })
  }

  if (method === 'POST' && (path === '/snapshots/remove' || path === '/snapshots/tag')) {
    return send(res, 200, { ok: true })
  }

  if (method === 'GET' && path === '/snapshots/logs') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('mock-runner: build path is stubbed; pull path has no logs\n')
    return
  }

  // --- sandbox endpoints -------------------------------------------------
  if (method === 'POST' && path === '/sandboxes') {
    const body = await readBody(req)
    console.log(`[mock-runner] create sandbox ${body?.id || '?'} from ${body?.snapshot || '?'}`)
    return send(res, 201, { id: body?.id || 'mock', daemonVersion: 'mock-0.0.1' })
  }

  const sandboxMatch = path.match(/^\/sandboxes\/[^/]+(?:\/(start|stop|destroy|info|backup|resize|recover|is-recoverable|network-settings))?$/)
  if (sandboxMatch) {
    if (path.endsWith('/is-recoverable')) {
      return send(res, 200, { recoverable: true })
    }
    if (method === 'GET') {
      return send(res, 200, { id: 'mock', state: 'started' })
    }
    return send(res, 200, { ok: true })
  }

  send(res, 404, { error: 'mock-runner: unhandled', method, path })
})

server.listen(PORT, () => {
  console.log(`[mock-runner] listening on :${PORT}`)
})
