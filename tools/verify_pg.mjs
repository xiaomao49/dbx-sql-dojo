import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

// 本地有中间产物 raw_questions_pg.json 时直接用它；CI 里该文件被 .gitignore
// 排除，就从最终发布的 ui/questions.js 读取，保证验的仍是随包发布的题库。
const rawPath = new URL('./raw_questions_pg.json', import.meta.url)
const bankPath = new URL('../ui/questions.js', import.meta.url)
let rows
if (fs.existsSync(rawPath)) {
  rows = JSON.parse(fs.readFileSync(rawPath, 'utf8'))
} else {
  const source = fs.readFileSync(bankPath, 'utf8')
  rows = JSON.parse(source.slice(source.indexOf('=') + 1).trim().replace(/;+\s*$/, ''))
}
const db = new PGlite()
await db.waitReady

const results = []
for (const q of rows) {
  let status = 'ok'
  let err = ''
  let nRows = 0
  try {
    await db.exec('drop schema public cascade; create schema public;')
    await db.exec(q.setup)
    // 与插件一致：有结果集就是 select，没有就是 DML。
    const r = await db.query(q.answer)
    const cols = (r.fields || []).map(f => f.name)
    if (cols.length) {
      nRows = r.rows.length
      if (nRows === 0) { status = 'empty'; err = '答案返回 0 行' }
    } else {
      const tables = (await db.query(`select tablename from pg_tables where schemaname='public'`)).rows
      let total = 0
      for (const t of tables) {
        const c = await db.query(`select count(*)::int as n from "${t.tablename}"`)
        total += c.rows[0].n
      }
      nRows = total
      if (total === 0) { status = 'empty'; err = '执行后表为空' }
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
