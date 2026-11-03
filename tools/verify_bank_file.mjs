// 用法：node tools/verify_bank_file.mjs testdata/ecommerce-bank.json
// 复刻插件 UI 里的导入校验逻辑，用来在本地确认题库文件能不能入库。
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const file = process.argv[2]
if (!file) {
  console.error('用法：node tools/verify_bank_file.mjs <题库.json>')
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'))
if (!Array.isArray(data.questions)) {
  console.error('缺少 questions 数组')
  process.exit(1)
}

const db = new PGlite()
await db.waitReady

const results = []
for (let i = 0; i < data.questions.length; i++) {
  const q = data.questions[i] ?? {}
  const title = String(q.title || `第 ${i + 1} 题`)
  let status = 'ok'
  let msg = ''
  try {
    if (!String(q.title || '').trim()) throw new Error('缺少 title')
    if (!String(q.setup || '').trim()) throw new Error('缺少 setup')
    if (!String(q.answer || '').trim()) throw new Error('缺少 answer')

    await db.exec('drop schema public cascade; create schema public;')
    await db.exec(q.setup)

    // 与插件一致：有结果集就是 select，没有就是 DML（不再靠首关键字猜）。
    const r = await db.query(q.answer)
    const cols = (r.fields || []).map(f => f.name)

    if (cols.length) {
      if (!r.rows.length) throw new Error('标准答案返回 0 行，检查数据或过滤条件')
      msg = `通过（${r.rows.length} 行 × ${cols.length} 列）`
    } else {
      const tables = (await db.query(`select tablename from pg_tables where schemaname='public'`)).rows
      if (!tables.length) throw new Error('执行后没有表')
      msg = '通过（DML）'
    }
  } catch (e) {
    status = 'fail'
    msg = (e.message || String(e)).split('\n')[0]
  }
  results.push({ no: i + 1, title, status, msg })
}

await db.close()

console.log(`题库：${data.name || '(未命名)'}  共 ${results.length} 题`)
for (const r of results) {
  const tag = r.status === 'ok' ? '✓ 通过' : '✗ 失败'
  console.log(`  ${String(r.no).padStart(2)}. ${tag}  ${r.title}  —  ${r.msg}`)
}
const ok = results.filter(r => r.status === 'ok').length
console.log(`合计 通过 ${ok} / ${results.length}`)
process.exit(ok === results.length ? 0 : 2)
