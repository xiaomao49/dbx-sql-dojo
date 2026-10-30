import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()

await db.exec(`
  create table products (id int, low_fats text, recyclable text);
  insert into products values (0,'Y','N'),(1,'Y','Y'),(2,'N','Y'),(3,'Y','Y');
`)

const r1 = await db.query(`select id from products where low_fats = 'Y' and recyclable = 'Y' order by id`)
console.log('基础查询:', r1.rows)

const r2 = await db.query(`select date '2024-01-31' + 1 as 加一天, date_add(date '2024-01-31', interval 1 day) as date_add`)
console.log('日期:', r2.rows)

const r3 = await db.query(`select '2024-01-31'::date + 1 as 转型后加一`)
console.log('转型:', r3.rows)

const r4 = await db.query(`
  select name, count(*) over () as 总数
  from (values ('a'),('b'),('c')) as t(name)
  limit 2
`)
console.log('窗口+limit:', r4.rows)

const r5 = await db.query(`select current_database() as db, version() as ver`)
console.log('版本:', r5.rows[0].ver.split(',')[0])

let err = null
try {
  await db.query(`select date('2024-01-31', '+1 day')`)
} catch (e) {
  err = e.message.split('\n')[0]
}
console.log('SQLite 写法在 PG 上:', err ? '报错 -> ' + err : '竟然能跑!')

await db.close()
