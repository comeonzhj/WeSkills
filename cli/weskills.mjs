#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { zipSync, unzipSync } from 'fflate'
import { parse as yaml } from 'yaml'

const manifest = '.weskills.json'
const client = 'weskills-cli'
const config = join(process.env.WESKILLS_CONFIG_DIR ?? join(homedir(), '.config', 'weskills'), 'credentials.json')
const reserved = new Set([manifest, '.git', '.DS_Store', 'node_modules'])
const maxBytes = 8 * 1024 * 1024
const help = `weskills login --server https://skills.example.com [--project team]
weskills pull --server URL --project team [--skill name] [--dir folder]
weskills sync --dir folder
weskills upload --dir folder [--server URL --project team] [--rebase]
weskills logout --server URL

Omit --skill to pull all visible Skills in the project.
pull, sync and upload are quiet by default. Pass --json for machine-readable status.
WESKILLS_TOKEN may supply a device token or account API token for a trusted server.`

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function jsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function saveConfig(value) {
  await mkdir(dirname(config), { recursive: true, mode: 0o700 })
  const temporary = `${config}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    await rename(temporary, config)
  } finally {
    await rm(temporary, { force: true })
  }
}

function origin(value) {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password) {
    throw new Error('Use an HTTPS server URL (HTTP is available on loopback).')
  }
  return url.origin
}

function segment(value, label) {
  if (!value || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

const projectEndpoint = project => `/api/projects/${segment(project, 'project')}/skills`
const endpoint = (project, skill) => `${projectEndpoint(project)}/${segment(skill, 'skill name')}`

async function request(server, pathname, token, options = {}) {
  const url = new URL(pathname, server)
  if (url.origin !== server) throw new Error('Unexpected registry origin')
  const headers = new Headers(options.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(url, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
}

async function responseJson(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || body.error || `Registry returned HTTP ${response.status}`)
  return body
}

function localPath(path) {
  const parts = path.split('/')
  if (path.includes('\\') || path.includes(':') || parts.some(part =>
    !part || part === '.' || part === '..' || reserved.has(part) || /[\u0000-\u001f]/.test(part))) {
    throw new Error(`Unsafe archive path: ${path}`)
  }
  return parts
}

async function collect(root, preserve = false) {
  const files = new Map()
  let total = 0
  async function visit(relative) {
    const dir = join(root, relative)
    if (!(await lstat(dir)).isDirectory()) throw new Error('Skill directory must be a real directory')
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = relative ? `${relative}/${item.name}` : item.name
      if (reserved.has(item.name)) {
        if (preserve && path !== manifest) files.set(path, Buffer.from('unmanaged local file'))
        continue
      }
      localPath(path)
      if (item.isDirectory()) {
        await visit(path)
      } else {
        if (!item.isFile()) throw new Error(`Unsupported Skill file: ${path}`)
        const absolute = join(root, path)
        total += (await lstat(absolute)).size
        if (total > maxBytes || files.size >= 200) throw new Error('Skill exceeds 8 MB or 200 files')
        files.set(path, await readFile(absolute))
      }
    }
  }
  await visit('')
  return files
}

function fingerprint(files) {
  return digest(JSON.stringify([...files].map(([name, data]) => [name, digest(data)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
}

function safeEntries(bytes) {
  let total = 0
  let count = 0
  const entries = new Map(Object.entries(unzipSync(bytes, { filter(file) {
    localPath(file.name)
    total += file.originalSize
    if (++count > 200 || total > maxBytes) throw new Error('Registry archive exceeds local limits')
    return true
  } })))
  if (!entries.has('SKILL.md')) throw new Error('Archive is missing SKILL.md')
  return entries
}

async function login(server, project, credentials) {
  if (project) segment(project, 'project')
  const form = fields => new URLSearchParams({ client_id: client, ...fields })
  const result = await responseJson(await request(server, '/api/oauth/device', null, {
    method: 'POST', body: form({ device_name: basename(homedir()), ...(project ? { scope: `project:${project}` } : {}) }),
  }))
  const verify = new URL(result.verification_uri_complete)
  if (verify.origin !== server) throw new Error('Unexpected verification origin')
  console.error(`Open ${verify.href} and approve access. Code: ${result.user_code}`)
  let interval = result.interval * 1000
  const deadline = Date.now() + result.expires_in * 1000
  while (Date.now() < deadline) {
    await wait(interval)
    const response = await request(server, '/api/oauth/token', null, {
      method: 'POST',
      body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: result.device_code }),
    })
    const body = await response.json()
    if (body.access_token) {
      await saveConfig({ ...credentials, [server]: body.access_token })
      return { status: 'signed_in' }
    }
    if (body.error === 'slow_down') interval += 5000
    else if (body.error !== 'authorization_pending') throw new Error(body.error || 'Device login failed')
  }
  throw new Error('Device code expired')
}

async function replace(root, entries, metadata, previousFingerprint, existed) {
  const parent = dirname(root)
  await mkdir(parent, { recursive: true })
  const workspace = await mkdtemp(join(parent, `.${basename(root)}-weskills-`))
  const staged = join(workspace, 'new')
  const backup = join(workspace, 'original')
  let preserve = false
  try {
    await mkdir(staged)
    for (const [name, data] of entries) {
      const file = join(staged, ...localPath(name))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, data, { flag: 'wx' })
    }
    await writeFile(join(staged, manifest), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 })
    if (existed) {
      if (fingerprint(await collect(root, true)) !== previousFingerprint) throw new Error('Local files changed during download')
      await rename(root, backup)
    } else {
      try { await lstat(root); throw new Error('Destination appeared during download') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    try {
      await rename(staged, root)
    } catch (error) {
      if (existed) {
        preserve = true
        await rename(backup, root)
        preserve = false
      }
      throw error
    }
  } finally {
    if (!preserve) await rm(workspace, { recursive: true, force: true })
  }
}

async function installation(root) {
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error('Skill directory must be a real directory')
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, metadata: null }
    throw error
  }
  return { exists: true, metadata: await jsonFile(join(root, manifest)) }
}

async function pullSkill({ server, project, token, root, name, metadata, exists, latest, preserveChanges }) {
  if (metadata && (name !== metadata.skill || project !== metadata.project || server !== origin(metadata.server))) {
    if (preserveChanges) return { status: 'local_changes' }
    throw new Error('Skill, server or project differs from the installation source')
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(latest.digest) || !Number.isSafeInteger(latest.version)) {
    throw new Error('Registry returned invalid version metadata')
  }
  if (metadata?.digest === latest.digest && metadata.version === latest.version) {
    return { status: 'current', version: latest.version }
  }
  const files = exists ? await collect(root, true) : new Map()
  const hash = fingerprint(files)
  if (exists && (metadata ? hash !== metadata.fingerprint : (await readdir(root)).length)) {
    if (preserveChanges) return { status: 'local_changes', version: latest.version }
    throw new Error('Destination contains local files or edits')
  }
  const response = await request(server, latest.url, token)
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (`sha256:${digest(bytes)}` !== latest.digest) throw new Error('Archive digest verification failed')
  const entries = safeEntries(bytes)
  await replace(root, entries, { server, project, skill: name, version: latest.version,
    digest: latest.digest, fingerprint: fingerprint(entries) }, hash, exists)
  return { status: 'updated', version: latest.version }
}

async function main() {
  const { positionals: [command], values } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: 'string' }, project: { type: 'string' }, skill: { type: 'string' }, dir: { type: 'string' },
      json: { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' }, help: { type: 'boolean', short: 'h' },
      rebase: { type: 'boolean' },
    },
  })
  if (!command || values.help || command === 'help') { console.log(help); return }
  if (!['login', 'logout', 'pull', 'sync', 'upload'].includes(command)) throw new Error(`Unknown command: ${command}`)
  const bulk = command === 'pull' && !values.skill
  const localOperation = ['sync', 'upload'].includes(command) || (command === 'pull' && !bulk)
  const root = resolve(values.dir ?? (command === 'pull'
    ? join('.agents', 'skills', ...(bulk ? [] : [segment(values.skill, 'skill name')])) : '.'))
  const { exists, metadata } = localOperation ? await installation(root) : { exists: false, metadata: null }
  if (command === 'sync' && !metadata) throw new Error('This directory has no WeSkills installation metadata')
  const specifiedServer = values.server ?? process.env.WESKILLS_SERVER
  const server = origin(specifiedServer ?? metadata?.server ?? (() => { throw new Error('Set --server') })())
  if (metadata && server !== origin(metadata.server)) throw new Error('Server differs from the installation source')
  const project = values.project ?? metadata?.project
  if (metadata && project !== metadata.project) throw new Error('Project differs from the installation source')
  const credentials = await jsonFile(config) ?? {}
  const token = (specifiedServer && process.env.WESKILLS_TOKEN) || credentials[server]
  let result
  if (command === 'login') {
    result = await login(server, project, credentials)
  } else if (command === 'logout') {
    if (credentials[server]) {
      const response = await request(server, '/api/oauth/revoke', null, {
        method: 'POST', body: new URLSearchParams({ client_id: client, token: credentials[server] }),
      })
      if (!response.ok) throw new Error(`Registry returned HTTP ${response.status} during logout`)
      delete credentials[server]
      await saveConfig(credentials)
    }
    result = { status: 'signed_out' }
  } else if (command === 'upload') {
    const files = await collect(root)
    const markdown = files.get('SKILL.md')?.toString('utf8') ?? ''
    const name = segment(yaml(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1] ?? '')?.name, 'Skill YAML name')
    if (metadata && metadata.skill !== name) throw new Error('Skill YAML name differs from the installed Skill')
    if (!token) throw new Error('Sign in before uploading')
    if (metadata && fingerprint(files) === metadata.fingerprint) {
      result = { status: 'unchanged' }
    } else {
      const bytes = zipSync(Object.fromEntries(files))
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Upload exceeds 2 MB compressed')
      const path = endpoint(project, name)
      const base = metadata && !values.rebase ? `?base=${Number(metadata.version)}` : ''
      result = await responseJson(await request(server, path + base, token, {
        method: 'PUT', headers: { 'Content-Type': 'application/zip' }, body: bytes,
      }))
    }
  } else if (bulk) {
    const { skills } = await responseJson(await request(server, projectEndpoint(project), token))
    if (!Array.isArray(skills)) throw new Error('Registry returned an invalid project catalog')
    const results = []
    for (const latest of skills) {
      const name = segment(latest.name, 'skill name')
      const destination = join(root, name)
      const local = await installation(destination)
      const outcome = await pullSkill({ server, project, token, root: destination, name, latest, ...local, preserveChanges: true })
      results.push({ name, ...outcome })
    }
    result = { skills: results }
  } else {
    const name = values.skill ?? metadata?.skill
    const latest = await responseJson(await request(server, endpoint(project, name), token))
    result = await pullSkill({ server, project, token, root, name, metadata, exists, latest, preserveChanges: command === 'sync' })
  }
  if (values.json && !values.quiet) console.log(JSON.stringify(result))
}

main().catch(error => {
  console.error(`weskills: ${error.message}`)
  process.exitCode = 1
})
