/* SQL 练习场 — DBX frontend plugin (PostgreSQL 18.6 via PGlite) */
const PROGRESS_KEY = 'progress';

const state = {
  bank: [],
  currentId: null,
  filter: 'all',
  done: new Set(),
  showSolution: false,
  persistent: false,
};

let pg = null;
let engineNotice = '';

/* ---------- storage ----------
 * 沙箱是 opaque origin，localStorage 在里面会直接抛 SecurityError，进度必须走
 * 宿主的 host.storage（manifest 里声明 host.storage 权限后才可用）。宿主没有
 * 授予存储能力时降级为内存态，并在界面上说明「本次会话有效」。 */
function uiStorage() {
  const api = window.dbxPlugin;
  return api && api.capabilities && api.capabilities.storage ? api.storage : null;
}

async function loadProgress() {
  const storage = uiStorage();
  if (!storage) return;
  try {
    const value = await storage.get(PROGRESS_KEY);
    state.persistent = true;
    if (Array.isArray(value)) {
      state.done = new Set(value.filter(n => Number.isInteger(n)));
    }
  } catch (_) {
    state.persistent = false;
  }
}

async function saveProgress() {
  const storage = uiStorage();
  if (!storage) return;
  try {
    await storage.set(PROGRESS_KEY, [...state.done]);
    state.persistent = true;
  } catch (_) {
    state.persistent = false;
  }
  renderProgress();
}

function renderProgress() {
  const node = document.getElementById('progress');
  if (!node) return;
  const suffix = state.persistent ? '' : ' · 本次会话有效';
  node.textContent = `进度 ${state.done.size}/${state.bank.length}${suffix}`;
}

/* ---------- helpers ---------- */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const DIFF_CN = { Easy: '简单', Medium: '中等', Hard: '困难' };

function parseSchema(setup) {
  const out = [];
  const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\);/gi;
  let m;
  while ((m = re.exec(setup))) {
    const cols = m[2].split(',').map(s => s.trim()).filter(Boolean)
      .map(s => s.split(/\s+/)[0].replace(/"/g, ''));
    out.push({ name: m[1], cols });
  }
  return out;
}

function normCell(v) {
  if (v === null || v === undefined) return '\u0000null';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : v;
  }
  if (v instanceof Uint8Array) return Array.from(v).join(',');
  return String(v);
}

function rowKey(row) { return row.map(normCell).join('\u0001'); }

function sameColumns(a, b) {
  return a.length === b.length && a.every((c, i) => String(c).toLowerCase() === String(b[i]).toLowerCase());
}

function sameRows(a, b) {
  if (a.length !== b.length) return false;
  const A = a.map(rowKey).sort();
  const B = b.map(rowKey).sort();
  return A.every((x, i) => x === B[i]);
}

/* ---------- postgres ---------- */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`脚本加载失败：${src}`));
    document.head.append(s);
  });
}

async function gunzipB64(b64) {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/* 宿主沙箱的 CSP 目前是 script-src 'unsafe-inline' blob: <asset>，没有
 * 'wasm-unsafe-eval'，WebAssembly.compile 会被拦下。先用 8 字节的最小模块
 * 探一下，拦了就给出中文说明，而不是把浏览器的英文 CSP 报错甩给用户。 */
async function wasmAllowed() {
  try {
    await WebAssembly.compile(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    return true;
  } catch (_) {
    return false;
  }
}

const WASM_BLOCKED_MSG =
  '当前版本的 DBX 插件沙箱还不允许运行 WebAssembly，内置 PostgreSQL 引擎因此无法启动。' +
  '题库和提示可以照常浏览；把 DBX 更新到支持 WebAssembly 的版本后重新打开本工作台即可运行 SQL。';

async function initEngine() {
  await loadScript('vendor/pglite-bundle.js');
  await loadScript('vendor/pglite-assets.js');
  const A = window.PGLITE_ASSETS;
  if (!A) throw new Error('PostgreSQL 资源没有加载成功');
  const [w, i, d] = await Promise.all([gunzipB64(A.wasm), gunzipB64(A.initdb), gunzipB64(A.data)]);
  let wasmModule, initdbModule;
  try {
    wasmModule = await WebAssembly.compile(w);
    initdbModule = await WebAssembly.compile(i);
  } catch (e) {
    // CSP 拦截时浏览器报的是英文 unsafe-eval 错误，统一换成中文说明。
    throw new Error(/unsafe-eval|wasm/i.test(String(e && e.message)) ? WASM_BLOCKED_MSG : `WebAssembly 编译失败：${e.message}`);
  }
  const db = new window.PGlite({
    pgliteWasmModule: wasmModule,
    initdbWasmModule: initdbModule,
    fsBundle: new Blob([d]),
  });
  await db.waitReady;
  return db;
}

async function engineLabel(db) {
  try {
    const r = await db.query('select version() as v');
    const m = /PostgreSQL\s+([\d.]+).*?PGlite\s+([\d.]+)/.exec(r.rows[0].v || '');
    return m ? `PostgreSQL ${m[1]} · PGlite ${m[2]}` : '';
  } catch (_) {
    return '';
  }
}

async function resetAndSetup(q) {
  await pg.exec('drop schema if exists public cascade; create schema public;');
  await pg.exec(q.setup);
}

async function runSql(sql) {
  const r = await pg.query(sql);
  const cols = (r.fields || []).map(f => f.name);
  return { columns: cols, values: r.rows.map(row => cols.map(c => row[c])) };
}

async function dumpTables() {
  const t = await pg.query("select tablename from pg_tables where schemaname = 'public' order by tablename");
  const out = [];
  for (const row of t.rows) {
    const name = row.tablename;
    const r = await pg.query(`select * from "${name}"`);
    const cols = (r.fields || []).map(f => f.name);
    out.push({ table: name, columns: cols, values: r.rows.map(x => cols.map(c => x[c])) });
  }
  return out;
}

/* ---------- verdict ---------- */
async function check(q, userSql) {
  let userOut;
  try {
    await resetAndSetup(q);
    if (q.type === 'dml') { await pg.exec(userSql); userOut = await dumpTables(); }
    else userOut = await runSql(userSql);
  } catch (e) {
    return { ok: false, msg: `SQL 执行出错：${(e.message || e).split('\n')[0]}` };
  }

  let ansOut;
  try {
    await resetAndSetup(q);
    if (q.type === 'dml') { await pg.exec(q.answer); ansOut = await dumpTables(); }
    else ansOut = await runSql(q.answer);
  } catch (e) {
    return { ok: false, msg: `标准答案执行失败（插件问题）：${(e.message || e).split('\n')[0]}` };
  }

  if (q.type === 'dml') {
    if (userOut.length !== ansOut.length) return { ok: false, msg: '表数量不一致。' };
    for (let i = 0; i < ansOut.length; i++) {
      if (!sameRows(userOut[i].values, ansOut[i].values)) {
        return { ok: false, msg: `表 ${ansOut[i].table} 的内容和预期不一致。` };
      }
    }
    return { ok: true, msg: '通过！数据已经按预期改好了。' };
  }

  if (!userOut.columns.length) {
    return { ok: false, msg: '查询没有返回结果集，检查一下是不是写了 DML 语句。' };
  }
  if (!sameColumns(userOut.columns, ansOut.columns)) {
    return { ok: false, msg: `列不一致：期望 ${ansOut.columns.join(', ')}，实际 ${userOut.columns.join(', ')}。` };
  }
  if (!sameRows(userOut.values, ansOut.values)) {
    return { ok: false, msg: `结果不一致：期望 ${ansOut.values.length} 行，你返回了 ${userOut.values.length} 行。` };
  }
  return { ok: true, msg: '通过！结果和标准答案一致。' };
}

/* ---------- render ---------- */
function renderList() {
  const list = document.getElementById('list');
  list.innerHTML = '';
  const items = state.bank.filter(q => state.filter === 'all' || q.difficulty === state.filter);
  for (const q of items) {
    const done = state.done.has(q.id);
    list.append(el('div', {
      class: `qitem${done ? ' done' : ''}${q.id === state.currentId ? ' active' : ''}`,
      onclick: () => openQuestion(q.id),
    },
      el('span', { class: 'no', text: String(q.id).padStart(2, '0') }),
      el('span', { class: `lv ${q.difficulty}` }),
      el('span', { class: 't', text: q.title }),
      el('span', { class: 'mark', text: done ? '✓' : '' }),
    ));
  }
  renderProgress();
}

function renderResult(container, columns, values) {
  container.innerHTML = '';
  if (!columns.length) {
    container.append(el('div', { class: 'empty', text: '没有结果集' }));
    return;
  }
  const table = el('table');
  const head = el('tr');
  for (const c of columns) head.append(el('th', { text: c }));
  table.append(el('thead', {}, head));
  const body = el('tbody');
  const limit = 200;
  for (const row of values.slice(0, limit)) {
    const tr = el('tr');
    for (const v of row) {
      tr.append(v === null
        ? el('td', {}, el('span', { class: 'null', text: 'NULL' }))
        : el('td', { text: v instanceof Date ? v.toISOString().slice(0, 10) : String(v) }));
    }
    body.append(tr);
  }
  table.append(body);
  container.append(table);
  if (values.length > limit) {
    container.append(el('div', { class: 'empty', text: `仅显示前 ${limit} 行，共 ${values.length} 行` }));
  }
}

function openQuestion(id) {
  state.currentId = id;
  state.showSolution = false;
  const q = state.bank.find(x => x.id === id);
  if (!q) return;
  renderList();

  const main = document.getElementById('detail');
  main.innerHTML = '';
  if (engineNotice) main.append(el('div', { class: 'verdict bad show', text: engineNotice }));

  const head = el('div', { class: 'qhead' },
    el('h2', { text: q.title }),
    el('span', { class: `badge ${q.difficulty}`, text: DIFF_CN[q.difficulty] || q.difficulty }),
    el('span', { class: 'badge', text: `力扣 ${q.lcId}` }),
    q.topic ? el('span', { class: 'badge topic', text: q.topic }) : null,
  );

  const desc = el('p', { class: 'desc', text: q.desc });

  const schemaWrap = el('div', { class: 'schema' });
  schemaWrap.append(el('h3', { text: '表结构' }));
  const st = el('table', { class: 'schema-tbl' });
  const trH = el('tr');
  trH.append(el('th', { text: '表名' }), el('th', { text: '字段' }));
  st.append(trH);
  for (const s of parseSchema(q.setup)) {
    const tr = el('tr');
    tr.append(el('td', { text: s.name }), el('td', { text: s.cols.join(', ') }));
    st.append(tr);
  }
  schemaWrap.append(st);

  const editor = el('textarea', { spellcheck: 'false', placeholder: '在这里写 SQL，Ctrl+Enter 检查' });

  const verdict = el('div', { class: 'verdict' });
  const resultWrap = el('div', { class: 'result' });
  const solutionWrap = el('div', { class: 'solution', style: 'display:none' });

  const runBtn = el('button', { class: 'btn', text: '运行' });
  const checkBtn = el('button', { class: 'btn primary', text: '检查答案' });
  const hintBtn = el('button', { class: 'btn', text: '💡 提示' });
  const showBtn = el('button', { class: 'btn', text: '看答案' });
  const resetBtn = el('button', { class: 'btn', text: '重置本题' });

  const hintWrap = el('div', { class: 'hint' },
    el('div', { class: 'hint-label', text: '💡 思路提示' }),
    el('div', { text: q.hint || '这题还没写提示。' }),
  );
  let hintOpen = false;
  function toggleHint(force) {
    hintOpen = force === undefined ? !hintOpen : force;
    hintWrap.classList.toggle('show', hintOpen);
    hintBtn.textContent = hintOpen ? '收起提示' : '💡 提示';
  }
  hintBtn.addEventListener('click', () => toggleHint());

  async function run(compare) {
    if (!pg) {
      verdict.className = 'verdict bad show';
      verdict.textContent = engineNotice || '数据库引擎没有启动，暂时无法运行 SQL。';
      return;
    }
    const sql = editor.value.trim();
    if (!sql) { verdict.className = 'verdict info show'; verdict.textContent = '先写点 SQL 吧。'; return; }
    runBtn.disabled = checkBtn.disabled = true;
    try {
      await resetAndSetup(q);
      if (q.type === 'dml') {
        await pg.exec(sql);
        const tables = await dumpTables();
        const t = tables[0] || { columns: [], values: [] };
        renderResult(resultWrap, t.columns, t.values);
      } else {
        const r = await runSql(sql);
        renderResult(resultWrap, r.columns, r.values);
      }

      if (compare) {
        const v = await check(q, sql);
        verdict.className = `verdict ${v.ok ? 'ok' : 'bad'} show`;
        verdict.textContent = v.ok ? `✅ ${v.msg}` : `❌ ${v.msg}`;
        if (v.ok) { state.done.add(q.id); saveProgress(); renderList(); }
        else { toggleHint(true); }
      } else {
        verdict.className = 'verdict info show';
        verdict.textContent = '已运行。检查答案请点右边的按钮。';
      }
    } catch (e) {
      verdict.className = 'verdict bad show';
      verdict.textContent = `SQL 执行出错：${(e.message || e).split('\n')[0]}`;
      resultWrap.innerHTML = '';
    } finally {
      runBtn.disabled = checkBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', () => run(false));
  checkBtn.addEventListener('click', () => run(true));
  showBtn.addEventListener('click', () => {
    state.showSolution = !state.showSolution;
    solutionWrap.style.display = state.showSolution ? 'block' : 'none';
    solutionWrap.textContent = q.answer;
    showBtn.textContent = state.showSolution ? '收起答案' : '看答案';
  });
  resetBtn.addEventListener('click', () => {
    editor.value = '';
    verdict.className = 'verdict';
    resultWrap.innerHTML = '';
    state.done.delete(q.id);
    saveProgress();
    renderList();
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(true); }
  });

  main.append(
    head, desc, schemaWrap,
    el('section', {}, el('h3', { text: '你的 SQL（PostgreSQL）' }), el('div', { class: 'editor-wrap' }, editor)),
    el('div', { class: 'actions' }, runBtn, checkBtn, hintBtn, showBtn, resetBtn),
    hintWrap,
    verdict,
    el('section', {}, el('h3', { text: '结果' }), resultWrap),
    el('section', {}, solutionWrap),
  );
}

/* ---------- boot ---------- */
function bindHeader() {
  document.querySelectorAll('.filters button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.f;
      document.querySelectorAll('.filters button').forEach(b => b.classList.toggle('active', b === btn));
      renderList();
    });
  });
}

async function loadBank() {
  if (Array.isArray(window.SQL_DOJO_BANK)) return window.SQL_DOJO_BANK;
  await loadScript('questions.js');
  if (!Array.isArray(window.SQL_DOJO_BANK)) throw new Error('题库脚本没有正确注入');
  return window.SQL_DOJO_BANK;
}

async function boot() {
  const main = document.getElementById('detail');
  main.innerHTML = '<div class="loading">正在启动 PostgreSQL 引擎（首次约 3-5 秒）…</div>';
  try {
    state.bank = await loadBank();
    bindHeader();
    await loadProgress();
    renderList();
    if (await wasmAllowed()) {
      try {
        pg = await initEngine();
        const badge = document.getElementById('engine');
        if (badge) badge.textContent = await engineLabel(pg);
      } catch (e) {
        engineNotice = e.message || String(e);
      }
    } else {
      engineNotice = WASM_BLOCKED_MSG;
    }
    // 引擎起不来也照样能浏览题库、看提示，只是不能运行 SQL。
    const first = state.bank.find(q => !state.done.has(q.id)) || state.bank[0];
    openQuestion(first.id);
  } catch (e) {
    main.innerHTML = '';
    main.append(el('div', { class: 'verdict bad show', text: `初始化失败：${e.message}` }));
  }
}

boot();
