/**
 * 端到端测试：在浏览器里用「宿主沙箱同款 CSP」跑 ui/，覆盖三条路径。
 *
 *   1. 宿主 CSP（无 'wasm-unsafe-eval'）→ 必须给出中文说明，题库仍可浏览，且不加载 4 MB 引擎；
 *   2. 宿主 CSP + 'wasm-unsafe-eval'  → 引擎启动、版本徽标、判题、进度持久化、刷新后打开下一题；
 *   3. 宿主没有 storage 能力           → 进度降级为「本次会话有效」，刷新后归零。
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

await browser.close()
server.close()

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：' + failed.map(f => f.name).join('、'))
  process.exit(1)
}
