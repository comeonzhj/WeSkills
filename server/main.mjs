import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { app } from '../src/index.ts'
import { scheduled } from '../src/scheduled.ts'
import { openBucket, openDatabase } from './storage.mjs'

const { SESSION_SECRET, PUBLIC_ORIGIN, DOWNLOAD_LOG_RETENTION_DAYS, DATA_DIR = 'data',
  HOST = '127.0.0.1', PORT = '8787', SETUP_TOKEN } = process.env
if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error('Set SESSION_SECRET to at least 32 characters')
const origin = new URL(PUBLIC_ORIGIN ?? `http://${HOST}:${PORT}`).origin
if (!/^https?:\/\//.test(origin)) throw new Error('PUBLIC_ORIGIN must use HTTP or HTTPS')
const env = {
  DB: openDatabase(DATA_DIR, 'migrations'),
  BUCKET: openBucket(DATA_DIR),
  SESSION_SECRET, DOWNLOAD_LOG_RETENTION_DAYS, SETUP_TOKEN,
}
const server = new Hono()
server.use('*', bodyLimit({ maxSize: 3 * 1024 * 1024, onError: c => c.text('Request too large', 413) }))
server.use('*', serveStatic({
  root: './public',
  onFound(path, c) {
    if (/^\/assets\/app\.[a-f0-9]{16}\.(css|js|png)$/.test(c.req.path)) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable')
    }
  },
}))
server.all('*', c => {
  // Use the configured public origin for cookies, CSRF and absolute registry URLs.
  const incoming = new URL(c.req.url)
  const request = new Request(origin + incoming.pathname + incoming.search, c.req.raw)
  request.headers.delete('CF-Connecting-IP')
  if (HOST === '127.0.0.1' && new URL(origin).protocol === 'https:') {
    const peer = request.headers.get('X-Real-IP')
    if (peer) request.headers.set('CF-Connecting-IP', peer)
  }
  return app.fetch(request, env, {
    waitUntil(promise) { promise.catch(error => console.error(error)) },
    passThroughOnException() {},
  })
})
serve({ fetch: server.fetch, hostname: HOST, port: Number(PORT) }, info => {
  console.log(`WeSkills listening on ${info.address}:${info.port}`)
})
async function maintain() {
  try {
    await scheduled({ scheduledTime: Date.now() }, env)
  } catch (error) {
    console.error('Maintenance failed', error)
  } finally {
    setTimeout(maintain, 60 * 60 * 1000).unref()
  }
}
void maintain()
