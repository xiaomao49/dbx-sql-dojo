/**
 * 端到端测试：在浏览器里用「宿主沙箱同款 CSP」跑 ui/，覆盖三条路径。
 *
 *   1. 宿主 CSP（无 'wasm-unsafe-eval'）→ 必须给出中文说明，题库仍可浏览，且不加载 4 MB 引擎；
 *   2. 宿主 CSP + 'wasm-unsafe-eval'  → 引擎启动、版本徽标、判题、进度持久化、刷新后打开下一题；
 *   3. 宿主没有 storage 能力           → 进度降级为「本次会话有效」，刷新后归零；
 *   4. 自定义题库导入                   → 分库存储、按结果集推断 select/DML、超大结果集拦截；
 *   5. v1 单键题库                      → 启动时自动迁移到分库存储，迁移后仍能判题。
 *
 * 用法：pnpm test:e2e（首次需要 npx playwright install chromium）
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const UI_DIR = path.join(ROOT, 'ui')

/* ---------- 极简静态服务器 ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
const pages = new Map()
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  if (pages.has(url)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(pages.get(url))
    return
  }
  const file = path.join(UI_DIR, url)
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
  res.end(fs.readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

/* ---------- 生成与宿主同构的沙箱页面 ---------- */
const indexHtml = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8')
const bodyHtml = indexHtml.replace(/<script src="app\.js"><\/script>/, '')

const csp = (wasm) => [
  "default-src 'none'",
  `script-src 'unsafe-inline' blob: ${origin}${wasm ? " 'wasm-unsafe-eval'" : ''}`,
  `style-src 'unsafe-inline' blob: ${origin}`,
  `img-src data: blob: ${origin}`,
  `font-src data: blob: ${origin}`,
  "connect-src 'none'",
].join('; ')

// 模拟宿主注入的 window.dbxPlugin，字段与插件开发文档里的 init 消息 / storage API 一致。
const bridge = (withStorage) => `
window.dbxPlugin = {
  capabilities: { storage: ${withStorage} },
  ${withStorage ? `storage: {
    get: async (k) => { const v = localStorage.getItem('dbx-stub:' + k); return v === null ? null : JSON.parse(v) },
    set: async (k, v) => { localStorage.setItem('dbx-stub:' + k, JSON.stringify(v === undefined ? null : v)) },
    delete: async (k) => { localStorage.removeItem('dbx-stub:' + k) },
  },` : ''}
};`

function sandboxPage({ wasm, storage }) {
  return bodyHtml
    .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp(wasm)}"><base href="${origin}/">`)
    .replace('<body>', `<body><script>${bridge(storage)}</script>`)
    .replace('</body>', '<script src="app.js"></script></body>')
}

pages.set('/blocked.html', sandboxPage({ wasm: false, storage: true }))
pages.set('/wasm.html', sandboxPage({ wasm: true, storage: true }))
pages.set('/no-storage.html', sandboxPage({ wasm: true, storage: false }))

/* ---------- 断言 ---------- */
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 980 } })
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })

async function newPage(file) {
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', e => problems.push(String(e.message).slice(0, 200)))
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text().slice(0, 200)) })
  await page.goto(origin + file)
  await page.waitForSelector('#list .qitem', { timeout: 30000 })
  return { page, problems }
}

const engineReady = (page) => page.waitForFunction(
  () => (document.getElementById('engine')?.textContent || '').includes('PostgreSQL'), null, { timeout: 90000 })

/* ---------- 1. 宿主 CSP 拦下 wasm ---------- */
{
  const { page, problems } = await newPage('/blocked.html')
  await page.waitForTimeout(1200)
  const banner = await page.locator('#detail .verdict').first().textContent()
  check('被拦时题库仍加载', await page.locator('#list .qitem').count() === 50)
  check('被拦时给出中文说明', banner.includes('不允许运行 WebAssembly'), banner.slice(0, 40))
  check('被拦时不出现英文 CSP 报错', !/unsafe-eval|Content Security/i.test(await page.content()))
  check('被拦时引擎徽标为空', (await page.locator('#engine').textContent()) === '')
  await page.fill('textarea', 'select 1')
  await page.locator('.actions button', { hasText: '运行' }).click()
  await page.waitForTimeout(500)
  check('被拦时点运行也走中文提示', (await page.locator('#detail .verdict').first().textContent()).includes('不允许运行 WebAssembly'))
  await page.locator('.actions button', { hasText: '💡 提示' }).click()
  check('被拦时提示可用', await page.locator('.hint.show').count() === 1)
  check('被拦时不加载 4 MB 引擎', !(await page.evaluate(() => !!(window.PGlite || window.PGLITE_ASSETS))))
  check('被拦时无控制台报错', problems.length === 0, problems.join(' | '))
  await page.close()
}

/* ---------- 2. 放开 wasm：引擎、判题、持久化 ---------- */
{
  const { page, problems } = await newPage('/wasm.html')
  const t0 = Date.now()
  await engineReady(page)
  check('引擎启动并自报版本', /PostgreSQL 18\.\d+ · PGlite 0\.5\.\d+/.test(await page.locator('#engine').textContent()), `${Date.now() - t0} ms`)

  const q1 = await page.evaluate(() => window.SQL_DOJO_BANK[0])
  await page.fill('textarea', 'select 999 as wrong_col')
  await page.locator('.actions button', { hasText: '检查答案' }).click()
  await page.waitForTimeout(2000)
  check('错误答案被判错', (await page.locator('#detail .verdict').first().textContent()).includes('❌'))
  check('答错自动展开提示', await page.locator('.hint.show').count() === 1)

  await page.fill('textarea', q1.answer)
  await page.locator('.actions button', { hasText: '检查答案' }).click()
  await page.waitForTimeout(2500)
  check('正确答案判对', (await page.locator('#detail .verdict').first().textContent()).includes('✅'))
  check('进度记为 1/50', (await page.locator('#progress').textContent()).includes('1/50'))
  check('进度写进宿主存储', JSON.stringify(await page.evaluate(() => localStorage.getItem('dbx-stub:progress'))) === JSON.stringify(`[${q1.id}]`))

  await page.reload()
  await engineReady(page)
  await page.waitForTimeout(800)
  check('刷新后进度保留', (await page.locator('#progress').textContent()).includes('1/50'))
  check('刷新后自动打开下一题', (await page.locator('#detail h2').textContent()) !== q1.title)

  await page.locator('#list .qitem').first().click()
  await page.waitForTimeout(400)
  await page.locator('.actions button', { hasText: '重置本题' }).click()
  await page.waitForTimeout(800)
  check('重置本题清空该题进度', (await page.locator('#progress').textContent()).includes('0/50'))
  check('重置后宿主存储同步清空', await page.evaluate(() => localStorage.getItem('dbx-stub:progress')) === '[]')
  check('放开 wasm 时无控制台报错', problems.length === 0, problems.join(' | '))
  await page.screenshot({ path: path.join(os.tmpdir(), 'sql-dojo-e2e.png') })
  await page.close()
}

/* ---------- 3. 宿主没有 storage 能力 ---------- */
{
  const { page, problems } = await newPage('/no-storage.html')
  await engineReady(page)
  check('无存储能力时标注本次会话', (await page.locator('#progress').textContent()).includes('本次会话有效'))
  const q1 = await page.evaluate(() => window.SQL_DOJO_BANK[0])
  await page.fill('textarea', q1.answer)
  await page.locator('.actions button', { hasText: '检查答案' }).click()
  await page.waitForTimeout(2500)
  check('无存储能力时仍能判题', (await page.locator('#progress').textContent()).includes('1/50'))
  await page.reload()
  await page.waitForSelector('#list .qitem')
  await page.waitForTimeout(600)
  check('无存储能力时刷新后归零', (await page.locator('#progress').textContent()).includes('0/50'))
  check('无存储能力时无控制台报错', problems.length === 0, problems.join(' | '))
  await page.close()
}

/* ---------- 4. 自定义题库：分库存储、类型推断、结果上限 ---------- */
{
  const { page, problems } = await newPage('/wasm.html')
  await engineReady(page)

  const waitVerdict = (text, timeout = 30000) => page.waitForFunction(
    t => (document.querySelector('#detail .verdict')?.textContent || '').includes(t), text, { timeout })

  await page.locator('#bank-btn').click()
  const paste = page.locator('textarea[placeholder*="粘贴"]')
  await paste.waitFor()

  const bank = {
    schemaVersion: 1,
    name: '测试题库',
    questions: [
      {
        title: '选择题', desc: '按 id 排序', difficulty: 'Easy',
        setup: 'create table t (id int); insert into t values (2),(1);',
        answer: '-- 注释开头也要能识别\nselect id from t order by id;',
      },
      {
        title: '更新题', desc: '把 id=1 的 v 改成 1', difficulty: 'Medium',
        setup: 'create table t (id int, v int); insert into t values (1,0),(2,0);',
        answer: '-- 注释开头\nwith x as (select 1 as id) update t set v = 1 where id in (select id from x);',
      },
      {
        title: '空结果题', desc: '故意返回 0 行', difficulty: 'Easy',
        setup: 'create table t (id int);',
        answer: 'select id from t;',
      },
    ],
  }
  await paste.fill(JSON.stringify(bank))
  await page.locator('button', { hasText: '导入粘贴内容' }).click()
  await page.waitForFunction(() => /已导入/.test(document.querySelector('#detail')?.textContent || ''), null, { timeout: 90000 })
  const status = await page.locator('#detail .verdict').first().textContent()
  check('导入只收下可通过验证的题', status.includes('已导入「测试题库」2 题'), status.slice(0, 60))
  const details = await page.locator('#detail .import-details').textContent()
  check('0 行答案被拒绝', details.includes('第 3 题'), details.slice(0, 120))

  const keys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('dbx-stub:custom-bank')))
  check('题库按 key 分开存储', keys.includes('dbx-stub:custom-bank-index') && keys.some(k => k.startsWith('dbx-stub:custom-bank:')), keys.join(', '))
  check('不再写 v1 单键', !(await page.evaluate(() => localStorage.getItem('dbx-stub:custom-banks'))))

  await page.selectOption('#custom-bank', '')
  await page.waitForTimeout(300)
  check('自定义分类列出 2 题', await page.locator('#list .qitem').count() === 2)
  const nos = await page.locator('#list .qitem .no').allTextContents()
  check('自定义题使用连续编号', nos.join(',') === '01,02', nos.join(','))

  const optionValues = await page.locator('#custom-bank option').evaluateAll(opts => opts.map(o => o.value))
  check('自定义下拉列出题库集', optionValues.length === 2 && optionValues[0] === '', optionValues.join(','))
  await page.selectOption('#custom-bank', optionValues[1])
  await page.waitForTimeout(200)
  check('按题库集筛选', await page.locator('#list .qitem').count() === 2)
  await page.selectOption('#custom-bank', '')

  await page.locator('#list .qitem').filter({ hasText: '选择题' }).click()
  await page.fill('#detail textarea', 'select id from t order by id;')
  await page.locator('.actions button', { hasText: '检查答案' }).click()
  await waitVerdict('✅')
  check('注释开头的 select 答案判对', true)

  await page.fill('#detail textarea', 'select id from t order by id desc;')
  await page.locator('.actions button', { hasText: '检查答案' }).click()
  await waitVerdict('顺序')
  check('行顺序不一致被判错', true)

  await page.fill('#detail textarea', 'select g from generate_series(1, 20001) g;')
  await page.locator('.actions button', { hasText: '检查答案' }).click()
  await waitVerdict('超过 20000 行')
  check('超大结果集被拒', true)

  await page.locator('#list .qitem').filter({ hasText: '更新题' }).click()
  await page.fill('#detail textarea', 'update t set v = 2;')
  await page.locator('.actions button', { hasText: '检查答案' }).click()
  await waitVerdict('❌')
  check('错误的 DML 被判错', true)

  await page.fill('#detail textarea', 'update t set v = 1 where id = 1;')
  await page.locator('.actions button', { hasText: '检查答案' }).click()
  await waitVerdict('✅')
  check('正确的 DML 被判对', true)

  check('判题结果有 aria-live', await page.locator('#detail .verdict').first().getAttribute('aria-live') === 'polite')
  check('列表项可键盘聚焦', await page.locator('#list .qitem').first().getAttribute('role') === 'button')

  await page.locator('#list .qitem').filter({ hasText: '选择题' }).click()
  await page.waitForTimeout(200)
  check('切回题目保留草稿', (await page.locator('#detail textarea').inputValue()).includes('generate_series'))

  await page.locator('#bank-btn').click()
  await page.waitForTimeout(200)
  await page.locator('.bankrow button', { hasText: '导出' }).first().click()
  await page.waitForFunction(() => /复制到剪贴板|已导出/.test(document.querySelector('#detail')?.textContent || ''), null, { timeout: 10000 })
  check('导出题库走剪贴板兜底', (await page.locator('#detail').textContent()).includes('复制到剪贴板'))

  await page.evaluate(() => {
    window.dbxPlugin.capabilities = { ...(window.dbxPlugin.capabilities || {}), fileTransfer: true }
    window.dbxPlugin.fileTransfer = {
      beginSave: async () => null,
      read: async () => ({ dataBase64: '', length: 0, eof: true }),
      cancel: async () => {},
      pick: async () => ({ files: [] }),
    }
  })
  await page.locator('.bankrow button', { hasText: '导出' }).first().click()
  await page.waitForFunction(() => /已取消导出/.test(document.querySelector('#detail')?.textContent || ''), null, { timeout: 10000 })
  check('取消保存不显示已导出', !(await page.locator('#detail').textContent()).includes('已导出「'))

  await page.reload()
  await engineReady(page)
  await page.selectOption('#custom-bank', '')
  await page.waitForTimeout(300)
  check('刷新后自定义题库仍在', await page.locator('#list .qitem').count() === 2)

  await page.locator('#list .qitem').filter({ hasText: '选择题' }).click()
  await page.waitForTimeout(200)
  const draftValue = await page.locator('#detail textarea').inputValue()
  const draftsAfter = await page.evaluate(() => localStorage.getItem('dbx-stub:drafts'))
  check('刷新后草稿仍在', draftValue.includes('generate_series'), `value=${draftValue.slice(0, 40)} drafts=${String(draftsAfter).slice(0, 120)}`)

  await page.locator('#reset-progress').click()
  await page.waitForFunction(() => document.querySelector('#reset-progress').textContent.includes('确定'))
  await page.locator('#reset-progress').click()
  await page.waitForTimeout(400)
  check('一键重置清空进度', (await page.locator('#progress').textContent()).includes('0/'))

  check('自定义题库流程无控制台报错', problems.length === 0, problems.join(' | '))
  await page.close()
}

/* ---------- 5. v1 单键题库自动迁移 ---------- */
{
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', e => problems.push(String(e.message).slice(0, 200)))
  await page.goto(origin + '/wasm.html')
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('dbx-stub:custom-bank')) localStorage.removeItem(k)
    }
    localStorage.setItem('dbx-stub:custom-banks', JSON.stringify({
      schemaVersion: 1,
      banks: [{
        id: 'b1', name: '旧题库', importedAt: new Date().toISOString(),
        questions: [{
          id: 'c1', title: '旧题', desc: '', difficulty: 'Easy', hint: '',
          setup: 'create table t (id int); insert into t values (1);',
          answer: 'select id from t;', type: 'select',
        }],
      }],
    }))
  })
  await page.reload()
  await engineReady(page)
  await page.selectOption('#custom-bank', '')
  await page.waitForTimeout(300)
  check('v1 题库自动迁移', await page.locator('#list .qitem').count() === 1)
  check('迁移后改用分库键', await page.evaluate(() => !!localStorage.getItem('dbx-stub:custom-bank-index')))
  check('迁移后删除旧键', await page.evaluate(() => localStorage.getItem('dbx-stub:custom-banks') === null))

  await page.locator('#list .qitem').first().click()
  await page.fill('#detail textarea', 'select id from t;')
  await page.locator('.actions button', { hasText: '检查答案' }).click()
  await page.waitForFunction(() => (document.querySelector('#detail .verdict')?.textContent || '').includes('✅'), null, { timeout: 30000 })
  check('迁移后的题目仍能判题', true)
  check('迁移流程无控制台报错', problems.length === 0, problems.join(' | '))
  await page.close()
}

/* ---------- 6. 导入可以中途取消 ---------- */
{
  const { page, problems } = await newPage('/wasm.html')
  await engineReady(page)
  await page.locator('#bank-btn').click()
  await page.waitForSelector('textarea[placeholder*="粘贴"]')

  const result = await page.evaluate(async () => {
    const bank = {
      schemaVersion: 1,
      name: '慢题库',
      questions: Array.from({ length: 20 }, (_, i) => ({
        title: `慢题 ${i + 1}`,
        difficulty: 'Easy',
        setup: 'create table t (id int); insert into t values (1);',
        answer: 'select id from t;',
      })),
    }
    let checked = 0
    const parsed = await parseBankText(JSON.stringify(bank), () => { checked += 1 }, () => checked >= 2)
    return { cancelled: parsed.cancelled === true, kept: parsed.questions.length, checked }
  })
  check('导入可以中途取消', result.cancelled && result.kept < 20, JSON.stringify(result))
  check('管理页保留取消入口', await page.locator('button', { hasText: '取消导入' }).count() === 1)
  check('取消流程无控制台报错', problems.length === 0, problems.join(' | '))
  await page.close()
}

/* ---------- 7. 超限题库在验证前被拒绝 ---------- */
{
  const { page, problems } = await newPage('/wasm.html')
  await engineReady(page)
  await page.locator('#bank-btn').click()
  const paste = page.locator('textarea[placeholder*="粘贴"]')
  await paste.waitFor()
  const text = fs.readFileSync(path.join(ROOT, 'testdata', 'oversize-sql-bank.json'), 'utf8')
  await paste.fill(text)
  await page.locator('button', { hasText: '导入粘贴内容' }).click()
  await page.waitForFunction(() => /超过宿主单值上限/.test(document.querySelector('#detail')?.textContent || ''), null, { timeout: 20000 })
  check('超限题库在验证前被拒绝', true)
  check('超限流程无控制台报错', problems.length === 0, problems.join(' | '))
  await page.close()
}

/* ---------- 8. 大文件分块读取 ---------- */
{
  const { page, problems } = await newPage('/wasm.html')
  await engineReady(page)
  const ok = await page.evaluate(async () => {
    const text = 'x'.repeat(300000) // 超过 256 KiB 的读取块，会分成两块
    const bytes = new TextEncoder().encode(text)
    window.dbxPlugin.capabilities = { ...(window.dbxPlugin.capabilities || {}), fileTransfer: true }
    window.dbxPlugin.fileTransfer = {
      read: async (handleId, offset, size) => {
        const slice = bytes.slice(offset, offset + size)
        let bin = ''
        for (const b of slice) bin += String.fromCharCode(b)
        return {
          dataBase64: btoa(bin),
          length: slice.length,
          eof: offset + slice.length >= bytes.length,
        }
      },
      cancel: async () => {},
    }
    return (await readTextFile('h')) === text
  })
  check('大文件分块读取完整', ok)
  check('分块读取无控制台报错', problems.length === 0, problems.join(' | '))
  await page.close()
}

await browser.close()
server.close()

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：' + failed.map(f => f.name).join('、'))
  process.exit(1)
}
