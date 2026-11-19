import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const password = 'test-only-long-password'
const sample = name => `---\nname: ${name}\ndescription: Enterprise workflow example\n---\n\n# Example\n`

test('permissions, quiet CLI, review workflow, Agent templates and rankings', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'weskills-e2e-'))
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  const origin = `http://127.0.0.1:${port}`
  const node = spawn(process.execPath, ['dist/server.cjs'], {
    env: { ...process.env, SESSION_SECRET: 'test-only-session-secret-000000000000', SETUP_TOKEN: 'test-setup',
      PUBLIC_ORIGIN: origin, DATA_DIR: join(scratch, 'data'), HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  node.stderr.on('data', chunk => { log += chunk })
  t.after(async () => {
    if (node.exitCode === null) {
      node.kill()
      await once(node, 'exit')
    }
    await rm(scratch, { recursive: true, force: true })
  })
  await Promise.race([
    once(node.stdout, 'data'),
    once(node, 'exit').then(() => { throw new Error(log) }),
  ])

  const http = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options })
  async function open(path, session) {
    return http(path, { headers: session ? { Cookie: session } : undefined })
  }
  async function post(path, session, fields = {}) {
    const csrf = session && /name="_csrf" value="([^"]+)"/.exec(await (await open('/me', session)).text())?.[1]
    if (session) assert.ok(csrf, 'session should receive a CSRF token')
    const body = new FormData()
    for (const [name, value] of Object.entries(fields)) body.set(name, value)
    if (csrf) body.set('_csrf', csrf)
    return http(path, { method: 'POST', headers: { Origin: origin, ...(session ? { Cookie: session } : {}) }, body })
  }
  const cookie = response => response.headers.get('set-cookie')?.split(';')[0]
  async function account(username, manager) {
    const add = await post('/admin/users/new', admin, { username, password, role: 'member' })
    assert.equal(add.status, 302)
    const html = await (await open('/admin/users', admin)).text()
    const id = [...html.matchAll(/href="\/admin\/users\/([a-f0-9]+)"[^>]*>([\w-]+)<\/a>/g)]
      .find(match => match[2] === username)?.[1]
    assert.ok(id, `Missing account row for ${username}`)
    if (manager !== undefined) {
      const grant = await post('/p/default/members', admin, { user: id, role: manager ? 'admin' : 'member' })
      assert.equal(grant.status, 302)
    }
    const session = cookie(await post('/login', null, { username, password }))
    assert.ok(session)
    return { id, session }
  }
  async function apiToken(session) {
    const response = await post('/me/api-token', session)
    const token = /sgt_[a-f0-9]{32}/.exec(await response.text())?.[0]
    assert.ok(token)
    return token
  }
  async function cli(token, ...args) {
    return exec(process.execPath, ['cli/weskills.mjs', ...args], {
      env: { ...process.env, WESKILLS_SERVER: origin, WESKILLS_CONFIG_DIR: join(scratch, 'credentials'), WESKILLS_TOKEN: token ?? '' },
    })
  }
  async function loadSkill(name, destination) {
    const provided = process.env.WESKILLS_FIXTURES
    if (provided) {
      await cp(join(provided, name), destination, { recursive: true })
    } else {
      await mkdir(destination)
      await writeFile(join(destination, 'SKILL.md'), sample(name === 'Interaction-PRD' ? 'interaction-prd' : 'pm-make'))
    }
    return destination
  }

  assert.equal((await post('/setup', null, { username: 'root', password })).status, 403)
  const admin = cookie(await post('/setup', null, { username: 'root', password, setupToken: 'test-setup' }))
  assert.ok(admin)
  assert.equal((await open('/setup')).status, 404)
  const employee = await account('employee', false)
  const reviewer = await account('reviewer', true)
  const outsider = await account('outsider')
  const adminToken = await apiToken(admin)
  const memberToken = await apiToken(employee.session)
  const outsiderToken = await apiToken(outsider.session)
  const interaction = await loadSkill('Interaction-PRD', join(scratch, 'interaction'))
  const install = join(scratch, 'install')
  const memberInstall = join(scratch, 'member-install')
  const pm = await loadSkill('PM-Make', join(scratch, 'pm'))
  const upload = (token, dir, flags = []) => cli(token, 'upload', '--project', 'default', '--dir', dir, ...flags)
  const pull = (token, dir, flags = []) => cli(token, 'pull', '--project', 'default', '--skill', 'interaction-prd', '--dir', dir, ...flags)

  const direct = JSON.parse((await upload(adminToken, interaction, ['--json'])).stdout)
  assert.equal(direct.version, 1)
  assert.equal((await open('/p/default/s/interaction-prd')).status, 404)
  await assert.rejects(pull(outsiderToken, install), /404/)
  assert.equal((await pull(memberToken, memberInstall)).stdout, '')
  assert.equal((await pull(adminToken, install)).stdout, '')
  assert.match(await readFile(join(install, 'SKILL.md'), 'utf8'), /^## 更新规范$/m)
  await appendFile(join(memberInstall, 'SKILL.md'), '\nEmployee edit for review.\n')
  await writeFile(join(memberInstall, 'comparison.md'), 'A new companion file.\n')
  const pending = JSON.parse((await upload(memberToken, memberInstall, ['--json'])).stdout)
  assert.match(pending.version, new RegExp(`^${employee.id}-[0-9]+$`))
  const review = `/submissions/${pending.id}`
  assert.equal((await open(review, employee.session)).status, 404)
  assert.equal((await post(`${review}/approve`, outsider.session)).status, 404)
  assert.match(await (await open(review, reviewer.session)).text(), /\+Employee edit for review/)
  assert.match(await (await open(`${review}?file=comparison.md`, reviewer.session)).text(), /\+A new companion file/)
  const approvals = await Promise.all([
    post(`${review}/approve`, reviewer.session), post(`${review}/approve`, reviewer.session),
  ])
  assert.equal(approvals.filter(response => response.status === 303).length, 1)
  assert.ok(approvals.some(response => [404, 409].includes(response.status)))
  assert.equal((await cli(adminToken, 'sync', '--dir', install)).stdout, '')
  const released = await readFile(join(install, 'SKILL.md'), 'utf8')
  assert.match(released, new RegExp(`contributor: ${employee.id}`))
  assert.match(released, /^version: 2$/m)
  assert.equal(released.match(/^## 更新规范$/gm).length, 1)
  assert.equal(JSON.parse((await cli(memberToken, 'sync', '--dir', memberInstall, '--json')).stdout).status, 'local_changes')
  assert.match(await readFile(join(memberInstall, 'SKILL.md'), 'utf8'), /Employee edit for review/)
  await assert.rejects(upload(memberToken, memberInstall), /published version has changed/)

  const newSkill = JSON.parse((await upload(memberToken, pm, ['--json'])).stdout)
  assert.ok(newSkill.pending)
  assert.equal((await post(`/submissions/${newSkill.id}/reject`, reviewer.session)).status, 303)
  assert.equal((await open(`/submissions/${newSkill.id}/archive`, reviewer.session)).status, 404)
  const second = JSON.parse((await upload(memberToken, pm, ['--json'])).stdout)
  assert.equal((await post(`/submissions/${second.id}/approve`, reviewer.session)).status, 303)
  assert.equal((await open('/p/default/s/pm-make', employee.session)).status, 200)

  const fields = { project: 'default', name: 'Engineering handbook', description: 'Coding playbook',
    file: new File(['# Guidelines\n\nReview changes.\n'], 'AGENTS.md', { type: 'text/markdown' }) }
  const queued = await post('/agents/new', employee.session, fields)
  assert.equal(queued.status, 303)
  const standardId = new URL(queued.headers.get('location'), origin).searchParams.get('submitted')
  const approved = await post(`/submissions/${standardId}/approve`, reviewer.session)
  assert.equal(approved.status, 303)
  const standard = approved.headers.get('location')
  assert.equal((await open(standard, outsider.session)).status, 404)
  assert.match(await (await open('/agents?q=playbook', employee.session)).text(), /Engineering handbook/)
  const asset = await open(standard + '/download', employee.session)
  assert.equal(asset.headers.get('content-disposition'), 'attachment; filename="AGENTS.md"')
  assert.match(await asset.text(), /Review changes/)
  const ranking = await (await open('/rankings', employee.session)).text()
  assert.match(ranking, /interaction-prd/)
  assert.match(ranking, /Engineering handbook/)
  assert.match(ranking, /employee/)
  assert.match(ranking, /2 次获批/)
  assert.doesNotMatch(await (await open('/rankings', outsider.session)).text(), /interaction-prd|Engineering handbook/)
})
