import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const rows = JSON.parse(fs.readFileSync(new URL('./raw_questions_pg.json', import.meta.url), 'utf8'))
const db = new PGlite()
await db.waitReady

const results = []
for (const q of rows) {
  let status = 'ok'
  let err = ''
  let nRows = 0
  const body = q.answer.replace(/\/\*[\s\S]*?\*\//g, '').trim()
  const isDml = /^(delete|update|insert)\b/i.test(body)
  try {
    await db.exec('drop schema public cascade; create schema public;')
    await db.exec(q.setup)
    if (isDml) {
      await db.exec(q.answer)
      const tables = (await db.query(`select tablename from pg_tables where schemaname='public'`)).rows
      let total = 0
      for (const t of tables) {
        const r = await db.query(`select count(*)::int as n from "${t.tablename}"`)
        total += r.rows[0].n
      }
      nRows = total
      if (total === 0) { status = 'empty'; err = '执行后表为空' }
    } else {
      const r = await db.query(q.answer)
      nRows = r.rows.length
      if (nRows === 0) { status = 'empty'; err = '答案返回 0 行' }
    }
  } catch (e) {
    status = 'fail'
    err = (e.message || String(e)).split('\n')[0]
  }
  results.push({ id: q.id, status, err, nRows })
}

await db.close()

const ok = results.filter(r => r.status === 'ok').length
console.log(`total=${results.length} ok=${ok}`)
for (const r of results) {
  if (r.status !== 'ok') console.log(`  ${String(r.id).padStart(2)} ${r.status.padEnd(5)} ${r.err.slice(0, 110)}`)
}
