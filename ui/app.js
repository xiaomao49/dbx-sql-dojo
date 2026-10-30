/* SQL 练习场 — DBX frontend plugin */
const LS_KEY = 'sql-dojo.done.v1';

const state = {
  bank: [],
  currentId: null,
  filter: 'all',
  done: new Set(),
  showSolution: false,
};

let SQL = null;

/* ---------- storage ---------- */
function loadProgress() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) state.done = new Set(JSON.parse(raw));
  } catch (_) { /* opaque origin */ }
}

function saveProgress() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...state.done]));
  } catch (_) { /* ignore */ }
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
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
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

/* ---------- sqlite ---------- */
function makeDb(q) {
  const db = new SQL.Database();
  db.run(q.setup);
  return db;
}

function lastResult(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return { columns: [], values: [] };
  const r = res[res.length - 1];
  return { columns: r.columns, values: r.values };
}

function dumpTables(db) {
  const names = db.exec("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name");
  if (!names.length) return [];
  const out = [];
  for (const [n] of names[0].values) {
    const r = db.exec(`select * from "${n}"`);
    out.push({ table: n, columns: r[0].columns, values: r[0].values });
  }
  return out;
}

/* ---------- verdict ---------- */
function check(q, userSql) {
  let userOut;
  try {
    const db = makeDb(q);
    userOut = q.type === 'dml' ? dumpTables(db.run(userSql) && db) : lastResult(db, userSql);
    db.close();
  } catch (e) {
    return { ok: false, msg: `SQL 执行出错：${e.message}` };
  }

  let ansOut;
  try {
    const db = makeDb(q);
    ansOut = q.type === 'dml' ? dumpTables(db.run(q.answer) && db) : lastResult(db, q.answer);
    db.close();
  } catch (e) {
    return { ok: false, msg: `标准答案执行失败（插件问题）：${e.message}` };
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
  const total = state.bank.length;
  document.getElementById('progress').textContent = `进度 ${state.done.size}/${total}`;
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
        : el('td', { text: String(v) }));
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

  const head = el('div', { class: 'qhead' },
    el('h2', { text: q.title }),
    el('span', { class: `badge ${q.difficulty}`, text: DIFF_CN[q.difficulty] || q.difficulty }),
    el('span', { class: 'badge', text: `力扣 ${q.lcId}` }),
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

  const editor = el('textarea', { spellcheck: 'false', placeholder: '在这里写 SQL，Ctrl+Enter 运行' });
  editor.value = '';

  const verdict = el('div', { class: 'verdict' });
  const resultWrap = el('div', { class: 'result' });
  const solutionWrap = el('div', { class: 'solution', style: 'display:none' });

  const runBtn = el('button', { class: 'btn', text: '运行' });
  const checkBtn = el('button', { class: 'btn primary', text: '检查答案' });
  const showBtn = el('button', { class: 'btn', text: '看答案' });
  const resetBtn = el('button', { class: 'btn', text: '重置本题' });

  function run(compare) {
    const sql = editor.value.trim();
    if (!sql) { verdict.className = 'verdict info show'; verdict.textContent = '先写点 SQL 吧。'; return; }
    runBtn.disabled = checkBtn.disabled = true;
    try {
      const db = makeDb(q);
      if (q.type === 'dml') {
        db.run(sql);
        const tables = dumpTables(db);
        const t = tables[0] || { columns: [], values: [] };
        renderResult(resultWrap, t.columns, t.values);
      } else {
        const r = lastResult(db, sql);
        renderResult(resultWrap, r.columns, r.values);
      }
      db.close();

      if (compare) {
        const v = check(q, sql);
        verdict.className = `verdict ${v.ok ? 'ok' : 'bad'} show`;
        verdict.textContent = v.ok ? `✅ ${v.msg}` : `❌ ${v.msg}`;
        if (v.ok) { state.done.add(q.id); saveProgress(); renderList(); }
      } else {
        verdict.className = 'verdict info show';
        verdict.textContent = '已运行。检查答案请点右边的按钮。';
      }
    } catch (e) {
      verdict.className = 'verdict bad show';
      verdict.textContent = `SQL 执行出错：${e.message}`;
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
    el('section', {}, el('h3', { text: '你的 SQL' }), el('div', { class: 'editor-wrap' }, editor)),
    el('div', { class: 'actions' }, runBtn, checkBtn, showBtn, resetBtn),
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

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`脚本加载失败：${src}`));
    document.head.append(s);
  });
}

async function initEngine() {
  // 首选：wasm 内联版，不需要额外取文件；失败则退回纯 JS 版
  await loadScript('vendor/sql-wasm-inline.js');
  try {
    return await initSqlJs();
  } catch (e1) {
    await loadScript('vendor/sql-asm.js');
    try {
      return await initSqlJs();
    } catch (e2) {
      throw new Error(`${e1.message}；回退纯 JS 版也失败：${e2.message}`);
    }
  }
}

async function loadBank() {
  if (Array.isArray(window.SQL_DOJO_BANK)) return window.SQL_DOJO_BANK;
  await loadScript('questions.js');
  if (!Array.isArray(window.SQL_DOJO_BANK)) throw new Error('题库脚本没有正确注入');
  return window.SQL_DOJO_BANK;
}

async function boot() {
  const main = document.getElementById('detail');
  main.innerHTML = '<div class="loading">正在加载题库…</div>';
  try {
    SQL = await initEngine();
    state.bank = await loadBank();
    loadProgress();
    bindHeader();
    renderList();
    const first = state.bank.find(q => !state.done.has(q.id)) || state.bank[0];
    openQuestion(first.id);
  } catch (e) {
    main.innerHTML = '';
    main.append(el('div', { class: 'verdict bad show', text: `初始化失败：${e.message}` }));
  }
}

boot();
