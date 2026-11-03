// 生成大型测试题库：node tools/gen_large_bank.mjs
// 输出 testdata/large-sql-bank.json（可导入）和 testdata/oversize-sql-bank.json（超单库上限）
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(import.meta.dirname, '..', 'testdata')
const GROUPS = 20
const PER_GROUP = 10

const cities = ['北京', '上海', '广州', '深圳', '成都', '杭州', '武汉', '南京', '西安', '重庆']
const people = ['张三', '李四', '王五', '赵六', '钱七', '孙八']
const depts = ['研发', '销售', '运营', '财务']

function q(title, desc, difficulty, topic, hint, setup, answer) {
  return { title, desc, difficulty, topic, hint, setup, answer }
}

function build(i) {
  const out = []
  const tag = String(i).padStart(2, '0')

  // 1. 条件筛选
  {
    const t = `sales_${i}`
    const rows = cities.map((c, k) => {
      const amount = 120 + ((i + k) % 5) * 30
      const status = k % 2 ? 'paid' : 'pending'
      return `(${k + 1},'${c}',${amount},'${status}')`
    })
    out.push(q(
      `筛选已付款的大额订单 ${tag}`,
      `销售表里混有已付款和待付款的订单。找出状态为 paid 且金额不低于 150 的订单，按金额从高到低排列，金额相同时按编号升序。`,
      'Easy', '条件筛选',
      '状态和金额两个条件要同时满足，用 AND 连起来；排序写 order by amount desc, id。',
      `drop table if exists ${t};\ncreate table ${t} (id int, city text, amount int, status text);\ninsert into ${t} values ${rows.join(',')};`,
      `select id, city, amount from ${t} where status = 'paid' and amount >= 150 order by amount desc, id;`,
    ))
  }

  // 2. 分组聚合
  {
    const t = `orders_${i}`
    const rows = cities.map((c, k) => `(${k + 1},'${c}',${100 + ((i + k) % 6) * 50})`)
    out.push(q(
      `统计各城市订单数 ${tag}`,
      `按城市汇总订单，输出城市、订单数和总金额，按城市名的字典序排列。`,
      'Easy', '分组聚合',
      '用 group by city，计数用 count(*)，求和用 sum(amount)。',
      `drop table if exists ${t};\ncreate table ${t} (id int, city text, amount int);\ninsert into ${t} values ${rows.join(',')};`,
      `select city, count(*) as order_count, sum(amount) as total from ${t} group by city order by city;`,
    ))
  }

  // 3. 排序取前 N
  {
    const t = `orders_${i}`
    const rows = cities.map((c, k) => `(${k + 1},'${c}',${80 + ((i * 3 + k) % 7) * 40})`)
    const k = 2 + (i % 2)
    out.push(q(
      `金额最高的前 ${k} 笔订单 ${tag}`,
      `找出金额最高的 ${k} 笔订单，输出订单号和金额；金额相同时编号小的排在前面。`,
      'Easy', '排序与分页',
      'order by amount desc, id 之后再 limit。',
      `drop table if exists ${t};\ncreate table ${t} (id int, city text, amount int);\ninsert into ${t} values ${rows.join(',')};`,
      `select id, amount from ${t} order by amount desc, id limit ${k};`,
    ))
  }

  // 4. 多表连接
  {
    const a = `customers_${i}`
    const b = `orders_${i}`
    const cRows = people.map((n, k) => `(${k + 1},'${n}')`)
    const oRows = people.map((_, k) => `(${k + 1},${((i + k) % 6) + 1},${100 + ((i + k) % 4) * 30})`)
    out.push(q(
      `订单与客户姓名 ${tag}`,
      `订单表只存了客户编号。把订单和客户表连接起来，输出订单号、客户姓名和金额，按订单号升序。`,
      'Medium', '多表连接',
      '用 join ... on 把 orders.customer_id 关联到 customers.id。',
      `drop table if exists ${a};\ndrop table if exists ${b};\ncreate table ${a} (id int, name text);\ninsert into ${a} values ${cRows.join(',')};\ncreate table ${b} (id int, customer_id int, amount int);\ninsert into ${b} values ${oRows.join(',')};`,
      `select o.id, c.name, o.amount from ${b} o join ${a} c on o.customer_id = c.id order by o.id;`,
    ))
  }

  // 5. 窗口函数
  {
    const t = `staff_${i}`
    const rows = depts.flatMap((d, k) => people.slice(0, 2).map((n, j) => `('${n}${j + 1}','${d}',${6000 + ((i + k * 3 + j * 5) % 8) * 800})`))
    out.push(q(
      `部门内薪资排名 ${tag}`,
      `给每位员工计算其在所属部门内的薪资排名（薪资最高的排第 1），输出姓名、部门、薪资和排名，按部门、排名排序。`,
      'Hard', '窗口函数',
      'rank() over (partition by dept order by salary desc) 可以在不分组的情况下算排名。',
      `drop table if exists ${t};\ncreate table ${t} (name text, dept text, salary int);\ninsert into ${t} values ${rows.join(',')};`,
      `select name, dept, salary, rank() over (partition by dept order by salary desc) as rn from ${t} order by dept, rn, name;`,
    ))
  }

  // 6. 子查询
  {
    const t = `scores_${i}`
    const rows = people.map((n, k) => `(${k + 1},'${n}',${50 + ((i * 2 + k) % 6) * 10})`)
    out.push(q(
      `高于平均分的学生 ${tag}`,
      `找出分数高于全班平均分的学生姓名，按姓名字典序输出。`,
      'Medium', '子查询',
      '先写 (select avg(score) from ...) 作为比较值，再放到 where 里。',
      `drop table if exists ${t};\ncreate table ${t} (id int, name text, score int);\ninsert into ${t} values ${rows.join(',')};`,
      `select name from ${t} where score > (select avg(score) from ${t}) order by name;`,
    ))
  }

  // 7. NULL 处理
  {
    const t = `notes_${i}`
    const rows = people.map((n, k) => `(${k + 1},'${n}',${k % 3 === 0 ? 'null' : `'备注${k}'`})`)
    out.push(q(
      `没有备注的记录 ${tag}`,
      `备注字段允许为空。找出备注为 NULL 的记录，输出编号，按编号升序。`,
      'Medium', 'NULL 处理',
      'NULL 不能用 = 比较，要用 is null。',
      `drop table if exists ${t};\ncreate table ${t} (id int, name text, note text);\ninsert into ${t} values ${rows.join(',')};`,
      `select id from ${t} where note is null order by id;`,
    ))
  }

  // 8. UPDATE
  {
    const t = `stock_${i}`
    const rows = people.map((n, k) => `(${k + 1},'${n}',${20 + ((i + k) % 5) * 10})`)
    const id = (i % 6) + 1
    out.push(q(
      `给指定商品补货 ${tag}`,
      `把编号为 ${id} 的库存记录数量增加 15。`,
      'Medium', '数据修改',
      'update 表 set 列 = 列 + 值 where 编号 = ...。',
      `drop table if exists ${t};\ncreate table ${t} (id int, name text, qty int);\ninsert into ${t} values ${rows.join(',')};`,
      `update ${t} set qty = qty + 15 where id = ${id};`,
    ))
  }

  // 9. DELETE
  {
    const t = `stock_${i}`
    const rows = people.map((n, k) => `(${k + 1},'${n}',${10 + ((i + k) % 6) * 10})`)
    out.push(q(
      `清理低库存记录 ${tag}`,
      `删除库存数量低于 30 的记录，保留其余记录不动。`,
      'Medium', '数据修改',
      'delete from 表 where 条件，注意只删满足条件的行。',
      `drop table if exists ${t};\ncreate table ${t} (id int, name text, qty int);\ninsert into ${t} values ${rows.join(',')};`,
      `delete from ${t} where qty < 30;`,
    ))
  }

  // 10. 字符串函数
  {
    const t = `members_${i}`
    const rows = people.map((n, k) => `(${k + 1},'${n}','${k % 2 ? 'vip' : 'normal'}')`)
    const prefix = people[i % people.length][0]
    out.push(q(
      `按姓氏筛选会员 ${tag}`,
      `找出姓名以「${prefix}」开头的会员，输出编号和大写后的姓名，按编号升序。`,
      'Easy', '字符串函数',
      '用 like \'前缀%\' 匹配，upper(name) 转大写。',
      `drop table if exists ${t};\ncreate table ${t} (id int, name text, level text);\ninsert into ${t} values ${rows.join(',')};`,
      `select id, upper(name) as uname from ${t} where name like '${prefix}%' order by id;`,
    ))
  }

  return out
}

const questions = []
for (let i = 1; i <= GROUPS; i += 1) questions.push(...build(i))
if (questions.length !== GROUPS * PER_GROUP) throw new Error(`题目数量异常：${questions.length}`)

const large = { schemaVersion: 1, name: `大型 SQL 练习题库（${questions.length} 题）`, questions }
const oversize = {
  schemaVersion: 1,
  name: '超限题库（用于测试导入预检）',
  questions: questions.map((item, idx) => ({
    ...item,
    title: `${item.title}（超限 ${idx + 1}）`,
    desc: `${item.desc} 这是一段用于把题库体积推过宿主单值上限的填充说明，实际使用时可以删掉。`.repeat(6),
  })),
}

const write = (file, data) => {
  const text = JSON.stringify(data, null, 2)
  fs.writeFileSync(path.join(OUT, file), `${text}\n`)
  const bytes = Buffer.byteLength(text)
  console.log(`${file}: ${data.questions.length} 题, ${bytes} 字节 (${(bytes / 1024).toFixed(1)} KiB)`)
}

write('large-sql-bank.json', large)
write('oversize-sql-bank.json', oversize)
