/* SQL 练习场 — DBX frontend plugin (PostgreSQL 18.6 via PGlite) */
const PROGRESS_KEY = 'progress';
const BANK_KEY = 'custom-banks'; // v1 旧键，启动时迁移到分库存储
const BANK_INDEX_KEY = 'custom-bank-index';
const BANK_ITEM_PREFIX = 'custom-bank:';
/* 宿主限制：单值 256 KiB、全库 1 MiB。各留一点余量给 JSON 包装和索引。 */
const MAX_BANK_BYTES = 240 * 1024;
const MAX_TOTAL_BYTES = 1008 * 1024;
/* 单次查询最多取回 20000 行，避免用户写出笛卡尔积把引擎和界面一起拖死。 */
const MAX_RESULT_ROWS = 20000;

const state = {
  bank: [],
  builtin: [],
  customBanks: [],
  currentId: null,
  filter: 'all',
  done: new Set(),
  showSolution: false,
  persistent: false,
};

let pg = null;
let engineNotice = '';
let engineStatus = 'loading'; // loading | ready | blocked | error

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
      state.done = new Set(value.filter(n => Number.isInteger(n) || typeof n === 'string'));
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

function sameColumnSet(a, b) {
  if (a.length !== b.length) return false;
  const A = a.map(c => String(c).toLowerCase()).sort();
  const B = b.map(c => String(c).toLowerCase()).sort();
  return A.every((c, i) => c === B[i]);
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

/* 引擎在后台启动，失败时才在详情页顶部补一条说明；首屏不再等 3-5 秒。 */
function renderEngineBanner(main) {
  if (!main) return;
  const old = main.querySelector('.engine-banner');
  if (old) old.remove();
  if (engineNotice) main.prepend(el('div', { class: 'verdict bad show engine-banner', text: engineNotice }));
}

async function startEngine() {
  if (!(await wasmAllowed())) {
    engineStatus = 'blocked';
    engineNotice = WASM_BLOCKED_MSG;
    renderEngineBanner(document.getElementById('detail'));
    return;
  }
  try {
    const db = await initEngine();
    pg = db;
    engineStatus = 'ready';
    engineNotice = '';
    const badge = document.getElementById('engine');
    if (badge) badge.textContent = await engineLabel(db);
    renderEngineBanner(document.getElementById('detail'));
  } catch (e) {
    engineStatus = 'error';
    engineNotice = e.message || String(e);
    renderEngineBanner(document.getElementById('detail'));
  }
}

async function resetAndSetup(q) {
  await pg.exec('drop schema if exists public cascade; create schema public;');
  await pg.exec(q.setup);
}

function stripTrailingSemicolon(sql) {
  return String(sql).trim().replace(/;+\s*$/, '');
}

/* 包一层 LIMIT，让 PostgreSQL 只回传上限行数；否则大结果集会先全部物化到
 * wasm 内存里。PGlite 是单线程，statement_timeout 在 wasm 里不生效，这是目前
 * 唯一能挡住「一次查询撑爆界面」的手段。 */
async function runSql(sql) {
  const body = stripTrailingSemicolon(sql);
  let r;
  try {
    r = await pg.query(`select * from (\n${body}\n) as __dojo_result limit ${MAX_RESULT_ROWS + 1}`);
  } catch (_) {
    // 子查询包不住的写法（例如误把 DML 写进 select 题）回退到直接执行，
    // 让调用方按原来的错误路径处理。
    r = await pg.query(body);
  }
  const cols = (r.fields || []).map(f => f.name);
  const truncated = r.rows.length > MAX_RESULT_ROWS;
  return {
    columns: cols,
    values: r.rows.slice(0, MAX_RESULT_ROWS).map(row => cols.map(c => row[c])),
    truncated,
  };
}

async function dumpTables() {
  const t = await pg.query("select tablename from pg_tables where schemaname = 'public' order by tablename");
  const out = [];
  for (const row of t.rows) {
    const name = row.tablename;
    const count = await pg.query(`select count(*)::int as n from "${name}"`);
    if (count.rows[0].n > MAX_RESULT_ROWS) {
      throw new Error(`表 ${name} 有 ${count.rows[0].n} 行，超过单次比较上限 ${MAX_RESULT_ROWS} 行。`);
    }
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

  if (userOut.truncated) {
    return { ok: false, msg: `结果超过 ${MAX_RESULT_ROWS} 行，无法比较，请加上 LIMIT 或缩小查询范围。` };
  }

  let ansOut;
  try {
    await resetAndSetup(q);
    if (q.type === 'dml') { await pg.exec(q.answer); ansOut = await dumpTables(); }
    else ansOut = await runSql(q.answer);
  } catch (e) {
    return { ok: false, msg: `标准答案执行失败（插件问题）：${(e.message || e).split('\n')[0]}` };
  }

  if (ansOut.truncated) {
    return { ok: false, msg: `标准答案返回超过 ${MAX_RESULT_ROWS} 行（插件问题）。` };
  }

  if (q.type === 'dml') {
    if (userOut.length !== ansOut.length) return { ok: false, msg: '表数量不一致。' };
    for (let i = 0; i < ansOut.length; i++) {
      if (String(userOut[i].table).toLowerCase() !== String(ansOut[i].table).toLowerCase()) {
        return { ok: false, msg: `表名不一致：期望 ${ansOut[i].table}，实际 ${userOut[i].table}。` };
      }
      if (!sameColumnSet(userOut[i].columns, ansOut[i].columns)) {
        return { ok: false, msg: `表 ${ansOut[i].table} 的列不一致：期望 ${ansOut[i].columns.join(', ')}，实际 ${userOut[i].columns.join(', ')}。` };
      }
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

/* ---------- custom banks ---------- */
const DIFFS = ['Easy', 'Medium', 'Hard'];

function uiTransfer() {
  const api = window.dbxPlugin;
  if (!api || !api.capabilities || !api.capabilities.fileTransfer) return null;
  return api.fileTransfer || null;
}

async function readTextFile(handleId) {
  const ft = uiTransfer();
  const parts = [];
  let offset = 0;
  for (;;) {
    const chunk = await ft.read(handleId, offset, 256 * 1024);
    parts.push(chunk.dataBase64 || '');
    if (chunk.eof || !chunk.length) break;
    offset += chunk.length;
  }
  await ft.cancel(handleId).catch(() => {});
  const bin = atob(parts.join(''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

async function saveTextFile(name, text) {
  const ft = uiTransfer();
  const bytes = new TextEncoder().encode(text);
  const target = await ft.beginSave({ name, contentType: 'application/json', size: bytes.byteLength });
  if (!target) return false;
  const chunkBytes = target.chunkBytes || 64 * 1024;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const slice = bytes.slice(offset, offset + chunkBytes);
    const r = await ft.write(target.handleId, offset, slice);
    offset = r.nextOffset != null ? r.nextOffset : offset + slice.byteLength;
  }
  await ft.finish(target.handleId);
  return true;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function formatKb(bytes) {
  return `${Math.ceil(bytes / 1024)} KiB`;
}

/* 每个题库单独一个 key：宿主只保证单值 256 KiB，全部塞进一个 key 时稍大的题库
 * 会在写入阶段才失败，用户只能看到一句「保存失败」。v1 的单 key 数据在启动时迁移。 */
async function loadCustomBanks() {
  const storage = uiStorage();
  if (!storage) return [];
  try {
    const index = await storage.get(BANK_INDEX_KEY);
    if (index && Array.isArray(index.ids)) {
      const banks = [];
      for (const id of index.ids) {
        const bank = await storage.get(BANK_ITEM_PREFIX + id);
        if (bank && Array.isArray(bank.questions)) banks.push(bank);
      }
      return banks;
    }
  } catch (_) { /* fall through to v1 migration */ }
  try {
    const legacy = await storage.get(BANK_KEY);
    if (legacy && Array.isArray(legacy.banks) && legacy.banks.length) {
      try {
        await saveCustomBanks(legacy.banks);
        if (storage.delete) await storage.delete(BANK_KEY);
      } catch (_) { /* 迁移失败就先继续用旧数据 */ }
      return legacy.banks;
    }
  } catch (_) { /* ignore */ }
  return [];
}

async function saveCustomBanks(banks) {
  const storage = uiStorage();
  if (!storage) throw new Error('宿主没有提供存储能力，无法保存题库');
  const previous = new Set(state.customBanks.map(b => b.id));
  const next = new Set(banks.map(b => b.id));
  try {
    // 先写题目，最后写索引；中途失败时旧索引仍然有效，不会指向不存在的库。
    for (const bank of banks) await storage.set(BANK_ITEM_PREFIX + bank.id, bank);
    if (storage.delete) {
      for (const id of previous) if (!next.has(id)) await storage.delete(BANK_ITEM_PREFIX + id);
    }
    await storage.set(BANK_INDEX_KEY, { schemaVersion: 2, ids: banks.map(b => b.id) });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/quota|limit|size|large|exceed|full/i.test(msg)) {
      throw new Error(`题库超出宿主存储上限（单题库 ${formatKb(MAX_BANK_BYTES)}、全库 ${formatKb(MAX_TOTAL_BYTES)}）。请删除不需要的题库，或拆成多个文件导入。`);
    }
    throw e;
  }
  state.customBanks = banks;
}

function rebuildBank() {
  const custom = state.customBanks.flatMap(b => b.questions || []);
  state.bank = [...state.builtin, ...custom];
}

function nextCustomSeq(banks) {
  let max = 0;
  for (const b of banks) {
    for (const q of b.questions || []) {
      const m = /^c(\d+)$/.exec(String(q.id));
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

function normalizeQuestion(raw, index) {
  const no = index + 1;
  if (!raw || typeof raw !== 'object') return { error: `第 ${no} 题不是对象` };
  const title = String(raw.title || '').trim();
  const setup = String(raw.setup || '').trim();
  const answer = String(raw.answer || '').trim();
  if (!title) return { error: `第 ${no} 题缺少 title` };
  if (!setup) return { error: `第 ${no} 题缺少 setup` };
  if (!answer) return { error: `第 ${no} 题缺少 answer` };
  if (setup.length > 20000) return { error: `第 ${no} 题 setup 超过 20 KB` };
  if (answer.length > 20000) return { error: `第 ${no} 题 answer 超过 20 KB` };
  return {
    q: {
      title,
      desc: String(raw.desc || '').trim() || '（没有写题目描述）',
      difficulty: DIFFS.includes(raw.difficulty) ? raw.difficulty : 'Easy',
      topic: String(raw.topic || '').trim(),
      hint: String(raw.hint || '').trim(),
      setup,
      answer,
      type: null, // 由 validateQuestion 按实际执行结果判断，避免 WITH/行注释误判
      lcId: null,
    },
  };
}

/* 类型不再靠正则猜：执行标准答案，有结果集就是 select，没有就是 DML。
 * 这样 WITH ... UPDATE、以 -- 注释开头的答案也能判对。 */
async function validateQuestion(q) {
  if (!pg) return { ok: false, msg: '数据库引擎没启动，无法验证（需要 DBX 支持 WebAssembly）' };
  try {
    await pg.exec('drop schema if exists public cascade; create schema public;');
    await pg.exec(q.setup);
    const r = await pg.query(q.answer);
    const cols = (r.fields || []).map(f => f.name);
    if (cols.length) {
      if (!r.rows.length) return { ok: false, msg: '标准答案返回 0 行，检查数据或过滤条件' };
      return { ok: true, type: 'select', msg: `通过（${r.rows.length} 行 × ${cols.length} 列）` };
    }
    const tables = await dumpTables();
    if (!tables.length) return { ok: false, msg: '执行后没有表' };
    return { ok: true, type: 'dml', msg: '通过（DML）' };
  } catch (e) {
    return { ok: false, msg: (e.message || String(e)).split('\n')[0] };
  }
}

async function parseBankText(text, onProgress) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { error: `不是合法的 JSON：${e.message}` }; }
  if (!data || typeof data !== 'object') return { error: '顶层必须是一个对象' };
  if (!Array.isArray(data.questions)) return { error: '缺少 questions 数组' };
  if (!data.questions.length) return { error: 'questions 是空的' };
  if (data.questions.length > 200) return { error: '一次最多导入 200 题' };

  const name = String(data.name || '').trim() || '未命名题库';
  const results = [];
  const normalized = [];
  for (let i = 0; i < data.questions.length; i++) {
    const n = normalizeQuestion(data.questions[i], i);
    if (n.error) {
      results.push({ no: i + 1, title: String(data.questions[i]?.title || ''), ok: false, msg: n.error });
    } else {
      normalized.push({ no: i + 1, q: n.q });
    }
  }

  // 先按序列化体积估算，超过宿主单值上限就不必逐题跑引擎了。
  const estimate = utf8Bytes({
    id: 'b0000000000',
    name,
    importedAt: new Date().toISOString(),
    questions: normalized.map(x => ({ ...x.q, id: 'c0000' })),
  });
  if (estimate > MAX_BANK_BYTES) {
    return { error: `题库「${name}」约 ${formatKb(estimate)}，超过宿主单值上限 ${formatKb(MAX_BANK_BYTES)}，请拆成多个文件分别导入。` };
  }

  const questions = [];
  for (let i = 0; i < normalized.length; i++) {
    const { no, q } = normalized[i];
    const v = await validateQuestion(q);
    results.push({ no, title: q.title, ok: v.ok, msg: v.msg });
    if (v.ok) questions.push({ ...q, type: v.type });
    if (onProgress) onProgress(i + 1, normalized.length);
  }
  results.sort((a, b) => a.no - b.no);
  return { name, questions, results };
}

async function addCustomBank(name, questions) {
  const banks = [...state.customBanks];
  const start = nextCustomSeq(banks);
  const withIds = questions.map((q, i) => ({ ...q, id: `c${start + i}` }));
  const bank = {
    id: 'b' + Date.now().toString(36),
    name,
    importedAt: new Date().toISOString(),
    questions: withIds,
  };
  const bankBytes = utf8Bytes(bank);
  if (bankBytes > MAX_BANK_BYTES) {
    throw new Error(`题库「${name}」约 ${formatKb(bankBytes)}，超过宿主单值上限 ${formatKb(MAX_BANK_BYTES)}，请拆成多个文件分别导入。`);
  }
  const totalBytes = banks.reduce((sum, b) => sum + utf8Bytes(b), bankBytes);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`导入后题库总量约 ${formatKb(totalBytes)}，超过宿主全库上限 ${formatKb(MAX_TOTAL_BYTES)}，请先删除不需要的题库。`);
  }
  banks.push(bank);
  await saveCustomBanks(banks);
  rebuildBank();
}

async function removeCustomBank(bankId) {
  const bank = state.customBanks.find(b => b.id === bankId);
  const banks = state.customBanks.filter(b => b.id !== bankId);
  for (const q of bank?.questions || []) state.done.delete(q.id);
  await saveCustomBanks(banks);
  rebuildBank();
  await saveProgress();
}

function templateText() {
  return JSON.stringify({
    schemaVersion: 1,
    name: '我的题库',
    _help: '把 questions 里的题目换成你自己的。setup 用来建表和灌数据，answer 是标准答案。两个都要能在 PostgreSQL 上直接执行，answer 必须能返回至少一行结果。difficulty 只能填 Easy / Medium / Hard。',
    questions: [
      {
        title: '统计每个城市的订单数',
        desc: '按城市汇总订单数量，从多到少排列。',
        difficulty: 'Easy',
        topic: '分组聚合',
        hint: '先想清楚按什么分组、按什么排序。',
        setup: "drop table if exists demo_orders;\ncreate table demo_orders (id int, city text, amount int);\ninsert into demo_orders values (1,'北京',100),(2,'上海',200),(3,'北京',300),(4,'广州',50);",
        answer: 'select city, count(*) as order_count from demo_orders group by city order by order_count desc;',
      },
      {
        title: '每个城市金额最高的订单',
        desc: '找出每个城市金额最大的那一笔订单，输出订单号、城市和金额。',
        difficulty: 'Medium',
        topic: '窗口函数',
        hint: '可以用 row_number() over (partition by ... order by ...) 排个名再挑第一名。',
        setup: "drop table if exists demo_orders2;\ncreate table demo_orders2 (id int, city text, amount int);\ninsert into demo_orders2 values (1,'北京',100),(2,'北京',300),(3,'上海',200),(4,'上海',80);",
        answer: 'select id, city, amount from (select *, row_number() over (partition by city order by amount desc) as rn from demo_orders2) t where rn = 1 order by city;',
      },
    ],
  }, null, 2);
}

/* ---------- render ---------- */
const isCustomQuestion = q => /^c\d+$/.test(String(q.id));

function matchFilter(q, f) {
  if (f === 'all') return true;
  if (f === 'custom') return isCustomQuestion(q);
  return q.difficulty === f;
}

function renderList() {
  const list = document.getElementById('list');
  list.innerHTML = '';
  const items = state.bank.filter(q => matchFilter(q, state.filter));
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
  if (!items.length) {
    list.append(el('div', {
      class: 'loading',
      text: state.filter === 'custom'
        ? '尚未导入自定义题目。'
        : '该分类下暂无题目。',
    }));
  }
  renderProgress();
}

function renderCustomEmpty() {
  if (state.bank.some(isCustomQuestion)) return;
  state.currentId = null;
  const main = document.getElementById('detail');
  main.innerHTML = '';
  renderEngineBanner(main);
  main.append(el('div', { class: 'qhead' }, el('h2', { text: '自定义题库' })));
  main.append(el('p', {
    class: 'desc',
    text: '此分类用于练习自行编写的题目。请点击右上角的「题库管理」，在管理页下载模板、按字段说明填写题目后导入；也可以通过粘贴 JSON 的方式添加。导入时，每道题都会在本机 PostgreSQL 引擎中实际执行建表语句与标准答案，未通过验证的题目不会被写入题库。',
  }));
  main.append(el('div', { class: 'actions' },
    el('button', { class: 'btn primary', text: '前往题库管理', onclick: openBankManager }),
  ));
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
  renderEngineBanner(main);

  const head = el('div', { class: 'qhead' },
    el('h2', { text: q.title }),
    el('span', { class: `badge ${q.difficulty}`, text: DIFF_CN[q.difficulty] || q.difficulty }),
    q.lcId
      ? el('span', { class: 'badge', text: `力扣 ${q.lcId}` })
      : el('span', { class: 'badge', text: '自定义' }),
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

  const editor = el('textarea', { spellcheck: 'false', placeholder: '在此输入 SQL 语句，按 Ctrl+Enter 执行检查' });

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
    el('div', { text: q.hint || '本题暂未提供提示。' }),
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
      verdict.className = engineStatus === 'loading' ? 'verdict info show' : 'verdict bad show';
      verdict.textContent = engineStatus === 'loading'
        ? '数据库引擎正在启动（首次约 3-5 秒），请稍候再试。'
        : (engineNotice || '数据库引擎没有启动，暂时无法运行 SQL。');
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
        if (r.truncated) {
          verdict.className = 'verdict info show';
          verdict.textContent = `结果超过 ${MAX_RESULT_ROWS} 行，只显示前 ${MAX_RESULT_ROWS} 行。`;
        }
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

/* ---------- bank manager ---------- */
function openBankManager() {
  const main = document.getElementById('detail');
  state.currentId = null;
  state.showSolution = false;
  renderList();
  main.innerHTML = '';

  const back = el('button', { class: 'btn', text: '← 返回题目' });
  back.addEventListener('click', () => {
    const pool = state.filter === 'custom' ? state.bank.filter(isCustomQuestion) : state.bank;
    const first = pool.find(q => !state.done.has(q.id)) || pool[0];
    if (first) openQuestion(first.id);
    else renderCustomEmpty();
  });

  main.append(el('div', { class: 'qhead' }, el('h2', { text: '题库管理' }), back));

  main.append(el('p', {
    class: 'desc',
    text: '导入自定义题库可扩充练习内容。请先下载模板，按字段说明填写题目，再通过文件选择或粘贴内容的方式导入。导入过程中，每道题都会在本机 PostgreSQL 引擎中实际执行建表语句与标准答案；无法执行、或结果集为空的题目不会被写入题库，并逐条给出原因。',
  }));

  const status = el('div', { class: 'verdict' });
  const setStatus = (cls, text) => {
    status.className = `verdict ${cls} show`;
    status.textContent = text;
  };

  const listWrap = el('div', { class: 'bank-list' });

  const tplBtn = el('button', { class: 'btn', text: '下载模板' });
  const fileBtn = el('button', { class: 'btn', text: '导入文件' });
  const pasteArea = el('textarea', { placeholder: '或者把题库 JSON 直接粘贴到这里…', style: 'min-height:150px' });
  const pasteBtn = el('button', { class: 'btn primary', text: '导入粘贴内容' });

  async function doImport(text, source) {
    setStatus('info', `正在验证题库（${source}）…`);
    const parsed = await parseBankText(text, (n, total) => setStatus('info', `正在验证第 ${n}/${total} 题…`));
    if (parsed.error) { setStatus('bad', `导入失败：${parsed.error}`); return; }
    const bad = parsed.results.filter(r => !r.ok);
    if (!parsed.questions.length) {
      setStatus('bad', `没有可用的题目。${bad.map(b => `第 ${b.no} 题：${b.msg}`).join('；')}`);
      return;
    }
    try {
      await addCustomBank(parsed.name, parsed.questions);
    } catch (e) {
      setStatus('bad', `保存失败：${(e.message || e).split('\n')[0]}`);
      return;
    }
    const msg = `已导入「${parsed.name}」${parsed.questions.length} 题`
      + (bad.length ? `；${bad.length} 题未通过 —— ${bad.map(b => `第 ${b.no} 题（${b.msg}）`).join('；')}` : '');
    setStatus(bad.length ? 'info' : 'ok', msg);
    pasteArea.value = '';
    renderBankList();
    renderList();
  }

  tplBtn.addEventListener('click', async () => {
    const ft = uiTransfer();
    const text = templateText();
    if (!ft || !ft.beginSave) {
      try {
        await navigator.clipboard.writeText(text);
        setStatus('info', '当前宿主不支持保存文件，模板已复制到剪贴板。');
      } catch (_) {
        setStatus('bad', '当前宿主不支持保存文件，也无法访问剪贴板。');
      }
      return;
    }
    try {
      const ok = await saveTextFile('sql-dojo-template.json', text);
      if (ok) setStatus('ok', '模板已保存为 sql-dojo-template.json。');
    } catch (e) {
      setStatus('bad', `保存失败：${(e.message || e).split('\n')[0]}`);
    }
  });

  fileBtn.addEventListener('click', async () => {
    const ft = uiTransfer();
    if (!ft || !ft.pick) {
      setStatus('info', '当前宿主不支持选择文件，请用下面的粘贴方式导入。');
      return;
    }
    try {
      const res = await ft.pick({ multiple: false });
      const files = (res && res.files) || [];
      if (!files.length) return;
      const text = await readTextFile(files[0].handleId);
      await doImport(text, files[0].name);
    } catch (e) {
      setStatus('bad', `读取文件失败：${(e.message || e).split('\n')[0]}`);
    }
  });

  pasteBtn.addEventListener('click', () => {
    const text = pasteArea.value.trim();
    if (!text) { setStatus('info', '先粘贴题库内容。'); return; }
    doImport(text, '粘贴');
  });

  function renderBankList() {
    listWrap.innerHTML = '';
    if (!state.customBanks.length) {
      listWrap.append(el('div', { class: 'loading', text: '尚未导入自定义题库。' }));
      return;
    }
    for (const b of state.customBanks) {
      const info = el('div', {},
        el('strong', { text: b.name }),
        el('span', {
          class: 'bankmeta',
          text: ` · ${(b.questions || []).length} 题 · ${new Date(b.importedAt).toLocaleDateString()}`,
        }),
      );
      const del = el('button', { class: 'btn', text: '删除' });
      let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          del.textContent = '确定删除？';
          setTimeout(() => { armed = false; del.textContent = '删除'; }, 4000);
          return;
        }
        try {
          await removeCustomBank(b.id);
          renderBankList();
          renderList();
          setStatus('ok', `已删除「${b.name}」。`);
        } catch (e) {
          setStatus('bad', `删除失败：${(e.message || e).split('\n')[0]}`);
        }
      });
      listWrap.append(el('div', { class: 'bankrow' }, info, del));
    }
  }

  main.append(
    el('section', {}, el('h3', { text: '导入自定义题库' }),
      el('div', { class: 'bank-actions' }, tplBtn, fileBtn),
      pasteArea,
      el('div', { class: 'bank-actions' }, pasteBtn),
    ),
    status,
    el('section', {}, el('h3', { text: '已导入' }), listWrap),
  );

  renderBankList();
}

/* ---------- boot ---------- */
function bindHeader() {
  document.querySelectorAll('.filters button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.f;
      document.querySelectorAll('.filters button').forEach(b => b.classList.toggle('active', b === btn));
      renderList();
      const pool = state.bank.filter(q => matchFilter(q, state.filter));
      if (!pool.length) {
        if (state.filter === 'custom') renderCustomEmpty();
      } else if (!pool.some(q => q.id === state.currentId)) {
        const first = pool.find(q => !state.done.has(q.id)) || pool[0];
        openQuestion(first.id);
      }
    });
  });
  const bankBtn = document.getElementById('bank-btn');
  if (bankBtn) bankBtn.addEventListener('click', openBankManager);
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
    state.builtin = await loadBank();
    state.customBanks = await loadCustomBanks();
    rebuildBank();
    bindHeader();
    await loadProgress();
    renderList();
    // 先渲染题目，引擎在后台启动；首屏不用等 3-5 秒。
    const first = state.bank.find(q => !state.done.has(q.id)) || state.bank[0];
    openQuestion(first.id);
    void startEngine();
  } catch (e) {
    main.innerHTML = '';
    main.append(el('div', { class: 'verdict bad show', text: `初始化失败：${e.message}` }));
  }
}

boot();
