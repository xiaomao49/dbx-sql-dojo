# SQL 练习场（DBX 插件）

在 DBX 里刷力扣高频 SQL 50 题。题库和判题都在本地跑，不联网、不用配置数据库连接。

**引擎是 PostgreSQL 18.6**（PGlite 0.5.13，编译成 WebAssembly 跑在插件沙箱里），启动后界面右上角会显示引擎自报的版本，写的 SQL 和公司里用 PostgreSQL / DuckDB 是同一套语法。

## 安装

1. 打包好的安装包在 `dist/com.xiaomao49.sql-dojo-<version>-universal.dbxp`
2. 打开 DBX → 插件中心 → 设置，勾选「允许安装未签名开发包」
3. 导入 `.dbxp`（插件中心 → 安装 / 导入本地包）
4. 插件中心 → 已安装，打开「SQL 练习场」

修改代码后重新打包（CLI 版本锁定在 `package.json`，与发布工作流一致）：

```
pnpm install
pnpm package
```

## 功能

- 50 道力扣高频 SQL 题，按简单 / 中等 / 困难筛选，导入自定义题库后另有「自定义」分类
- 每题自带建表语句和测试数据，打开就能写
- 每题标了考察点（如「窗口函数」「NULL 处理」），带一句思路提示，**答错会自动展开提示**
- 「运行」看结果，「检查答案」判对错
- 判题不比对 SQL 文本，而是**分别执行你的 SQL 和标准答案，比较结果集**，写法不同但结果对就算过
- 进度通过宿主的 `host.storage` 持久化（插件专属键值存储），关闭再开还在；宿主没授予存储能力时降级为
  「本次会话有效」，并在进度旁标注
- **支持导入自己的题库**：下载模板 → 在别处写好题目 → 导回来。导入时每道题都会在本地 PostgreSQL 里
  实际跑一遍（建表、灌数据、执行标准答案），跑不出结果的不会入库，并逐题给出原因

## 权限与数据

声明的最小权限只有一项：

| 权限 | 用途 |
|---|---|
| `host.storage` | 保存做题进度和导入的自定义题库（插件专属键值存储，单值 256 KiB、全库 1 MiB） |

文件导入导出走 `window.dbxPlugin.fileTransfer`（原生打开/保存对话框），**不需要 manifest 权限**，
通过 `capabilities.fileTransfer` 探测可用性；宿主不支持时自动降级为「粘贴 JSON 导入」。

除此之外没有网络、没有连接、没有剪贴板读取。DBX 的插件沙箱是 opaque origin，
`localStorage` 在里面会直接抛 `SecurityError`，所以进度不走浏览器存储，走宿主提供的
`window.dbxPlugin.storage`。

## 体积与启动

| | |
|---|---|
| 安装包 | 约 5 MB |
| 插件目录 | 约 7.4 MB |
| 启动 | 约 3-5 秒 |

体积主要来自 PostgreSQL 引擎：`pglite.wasm` 原始 8.7 MB，gzip + base64 后约 4.2 MB。

## 结构

```
manifest.json              插件清单（version / engines / permissions）
dbx-plugin.toml            打包配置（include: assets, ui, LICENSE, THIRD_PARTY_NOTICES.md, licenses）
ui/index.html              界面
ui/app.js                  判题逻辑
ui/style.css               样式
ui/questions.js            题库（50 题，由构建脚本生成）
ui/vendor/pglite-bundle.js PGlite 的 JS 部分（esbuild 打包）
ui/vendor/pglite-assets.js PostgreSQL 的 wasm 和数据文件（gzip + base64）
LICENSE                    本插件的 MIT 许可
THIRD_PARTY_NOTICES.md     随包分发的第三方组件与许可说明
licenses/                  Apache-2.0、PostgreSQL License、题库 MIT 的原文
```

## 构建流程

### 1. 引擎资源

`ui/vendor/pglite-bundle.js` 由 esbuild 打包：

```
npx esbuild pg_entry.js --bundle --format=iife --platform=browser \
  --external:node:* --define:import.meta.url='"http://localhost/plugin/"' \
  --outfile=ui/vendor/pglite-bundle.js
```

`--define:import.meta.url` 是必须的：PGlite 内部会用它拼 wasm 路径，IIFE 格式下没有这个值会直接抛 `Invalid URL`。

`ui/vendor/pglite-assets.js` 由脚本生成（把 wasm 和数据文件 gzip 后转 base64 内联）：

```
python -I tools/build_pg_vendor.py
```

内联是因为 DBX 的插件沙箱**不允许 fetch 外部文件**，只能通过 `<script>` 加载脚本。运行时用 `DecompressionStream('gzip')` 解压，再传给 PGlite 的 `pgliteWasmModule` / `initdbWasmModule` / `fsBundle` 选项，绕开它默认的网络加载。

### 2. 题库

```
python -I tools/parse_bank_pg.py    # 解析 + MySQL→PostgreSQL 转换
node tools/verify_pg.mjs            # 用 PGlite 逐题跑一遍，应输出 total=50 ok=50
python -I tools/render_bank.py      # 合并标题/难度/题面/提示，生成 ui/questions.js
```

## 测试

```
pnpm test:e2e      # 浏览器里按「宿主沙箱同款 CSP」跑三条路径，首次需要 npx playwright install chromium
```

`tests/e2e/run.mjs` 把 `ui/` 放到一个和 DBX 宿主同构的 CSP 沙箱里跑，并注入一份与插件开发文档一致的
`window.dbxPlugin`：

1. 宿主 CSP（无 `'wasm-unsafe-eval'`）→ 给中文说明、题库仍可浏览、不加载 4 MB 引擎；
2. 宿主 CSP + `'wasm-unsafe-eval'` → 引擎启动、徽标显示版本、判题、进度写入宿主存储、刷新后仍在；
3. 宿主没有 `storage` 能力 → 进度降级为「本次会话有效」，刷新归零。

题库本身用 `node tools/verify_pg.mjs` 校验（应为 `total=50 ok=50`）。

## 题库从哪来

[Camio1945/leetcode-study-plan-top-sql-50](https://github.com/Camio1945/leetcode-study-plan-top-sql-50)，MIT 协议，许可证见 `licenses/question-bank-MIT.txt`（源仓库副本在 `tools/upstream/LICENSE`）。引擎与题库的第三方许可说明见 `THIRD_PARTY_NOTICES.md`。

原仓库是力扣学习计划「高频 SQL 50 题（基础版）」的 MySQL 版。标题和难度来自力扣题库接口，中文题面和提示是本插件自己写的（不整段转载力扣原文）。

## MySQL → PostgreSQL 都改了什么

`tools/parse_bank_pg.py` 里的 `convert()`：

- `ENUM(...)` → `text`
- `AUTO_INCREMENT` → 去掉
- `DATETIME` → `timestamp`
- `FLOAT(n,m)` → `numeric(n,m)`
- 反引号 → 双引号
- `IF(cond,a,b)` → `CASE WHEN ... END`
- `IFNULL` → `coalesce`
- `DATE_ADD/DATE_SUB(x, INTERVAL n DAY)` → `(x::timestamp ± interval 'n day')`
- `DATE_FORMAT` → `to_char`
- `GROUP_CONCAT` → `string_agg`
- `ROUND(x,n)` → `round((x)::numeric, n)`
- `LEFT(x,n)` → `left((x)::text, n)`
- `REGEXP` → `~`
- `LIMIT n,m` → `LIMIT m OFFSET n`

转换后仍有 4 题跑不通（双引号字符串、VARCHAR 与 INT 比较、HAVING 引用别名、正则转义），在 `tools/overrides_pg.json` 里逐题给出改写版。

## 加题 / 改题

1. 把题目 .sql 放进 `tools/upstream/`（保持三段结构：注释 / 建表+数据 / `/*---*/` / 答案）
2. 跑 `parse_bank_pg.py` + `verify_pg.mjs`，看是否 `ok`
3. 跑不通就在 `overrides_pg.json` 里加改写
4. 在 `render_bank.py` 的 `LC` / `SLUG` / `DESC` / `HINT` / `TOPIC` 里补信息
5. 跑 `render_bank.py`，重新打包

注意：`LC` 里的 key 是题序（1-50），不是力扣题号。

## 自定义题库格式

点「题库管理 → 下载模板」会得到一个 `sql-dojo-template.json`：

```json
{
  "schemaVersion": 1,
  "name": "我的题库",
  "questions": [
    {
      "title": "统计每个城市的订单数",
      "desc": "按城市汇总订单数量，从多到少排列。",
      "difficulty": "Easy",
      "topic": "分组聚合",
      "hint": "先想清楚按什么分组、按什么排序。",
      "setup": "create table demo_orders (id int, city text, amount int);\ninsert into demo_orders values (1,'北京',100);",
      "answer": "select city, count(*) as order_count from demo_orders group by city order by order_count desc;"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 题目名，显示在左侧列表 |
| `setup` | 是 | 建表和灌数据的 SQL，可以写多条 |
| `answer` | 是 | 标准答案，必须能返回至少一行结果 |
| `desc` | 否 | 题目描述 |
| `difficulty` | 否 | `Easy` / `Medium` / `Hard`，默认 Easy |
| `topic` | 否 | 考察点标签 |
| `hint` | 否 | 思路提示，答错时自动展开 |

规则：

- 每题 SQL 上限 20 KB，一次最多导入 200 题
- 导入时逐题执行验证：`setup` 跑不通、`answer` 报错、或 `answer` 返回 0 行的都不会入库
- 入库后 ID 以 `c` 开头（`c1`、`c2`…），和内置的 1–50 题不冲突
- 自定义题存在 `host.storage` 里，每个题库单独一个 key（单值上限 256 KiB），全库上限 1 MiB；导入前会先按体积检查，超过单库上限会提示拆成多个文件
- 单次查询最多取回 20000 行：运行时会截断显示，判题遇到超大结果集会直接拒绝并提示加 `LIMIT`

## 已知限制

- **需要宿主沙箱允许 WebAssembly。** 内置引擎要 `WebAssembly.compile`，而当前 DBX 宿主给插件沙箱的 CSP 是
  `script-src 'unsafe-inline' blob: <asset>`，没有 `'wasm-unsafe-eval'`，引擎会启动不了。插件本身已经做了
  预检：探到 wasm 被拦时直接给一句中文说明并保留题库浏览，不会甩英文 CSP 报错。宿主放开后，只把
  `manifest.json` 的 `engines.dbx` 提到对应版本、重发一版即可，代码不用再动。
- 只支持 PostgreSQL 方言。SQLite 专有写法（如 `date(d, '+1 day')`）会直接报错——这是刻意的，和真实数据库行为一致。
- 判题按「列名 + 行集合」比较，不要求行顺序，浮点按 6 位小数容差。
- 没有做「在你已打开的 DuckDB/MySQL 连接上跑」的模式。
- 首次打开要等 3-5 秒，是在解压和编译 PG 引擎，不是卡死。

## 打包注意

- 打包前确认 `include` 里的文件权限是 644（`chmod 644 LICENSE THIRD_PARTY_NOTICES.md licenses/*`），
  安装包里的 `manifest.json` 等文件也应是 0644，不要带执行位。
- `dbx-plugin.toml` 的 `[package].include` 既可以是目录也可以是单个文件；本插件把许可文件直接放在包根目录。
