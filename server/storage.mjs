import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export function openDatabase(directory, migrations) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(directory, 'weskills.sqlite'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON')
  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  db.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)')
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    transaction(() => {
      if (db.prepare('SELECT 1 FROM local_migrations WHERE name = ?').get(name)) return
      db.exec(readFileSync(join(migrations, name), 'utf8'))
      db.prepare('INSERT INTO local_migrations VALUES (?)').run(name)
    })
  }
  class Statement {
    constructor(sql, args = []) {
      this.sql = sql
      this.args = args
    }
    bind(...args) {
      return new Statement(this.sql, args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value))
    }
    statement() {
      // node:sqlite binds numbered placeholders by name.
      const statement = db.prepare(this.sql)
      const indexes = [...this.sql.matchAll(/\?(\d+)/g)].map(match => match[1])
      const named = Object.fromEntries(indexes.map(index => [`?${index}`, this.args[Number(index) - 1]]))
      return { statement, args: indexes.length ? [named] : this.args }
    }
    async first(column) {
      const { statement, args } = this.statement()
      const row = statement.get(...args)
      return (column === undefined ? row : row?.[column]) ?? null
    }
    async all() {
      const { statement, args } = this.statement()
      return { results: statement.all(...args), success: true, meta: { changes: 0 } }
    }
    execute() {
      const { statement, args } = this.statement()
      const { changes, lastInsertRowid } = statement.run(...args)
      return { results: [], success: true, meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } }
    }
    async run() {
      return this.execute()
    }
  }
  return {
    prepare: sql => new Statement(sql),
    batch: async statements => transaction(() => statements.map(statement => statement.execute())),
  }
}

export function openBucket(directory) {
  function file(key) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(key) || key.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Invalid storage key')
    }
    return resolve(directory, 'objects', key)
  }
  async function optional(action) {
    try {
      return await action()
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  return {
    head: key => optional(() => stat(file(key))),
    async get(key) {
      const bytes = await optional(() => readFile(file(key)))
      if (bytes === null) return null
      const blob = new Blob([bytes])
      return { body: blob.stream(), arrayBuffer: () => blob.arrayBuffer() }
    },
    async put(key, bytes) {
      const target = file(key)
      const temporary = `${target}.${randomUUID()}.tmp`
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      try {
        await writeFile(temporary, bytes, { mode: 0o600 })
        await rename(temporary, target)
      } finally {
        await rm(temporary, { force: true })
      }
    },
    delete: key => rm(file(key), { force: true }),
  }
}
