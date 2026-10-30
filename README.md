# SQL 练习场（DBX 插件）

在 DBX 里刷力扣高频 SQL 50 题。题库和判题都在本地跑，不联网、不用配置数据库连接。

**引擎是 PostgreSQL 16**（PGlite，编译成 WebAssembly 跑在插件沙箱里），写的 SQL 和公司里用 PostgreSQL / DuckDB 是同一套语法。

## 安装

1. 打包好的安装包在 `dist/com.mashidong.sql-dojo-<version>-universal.dbxp`
2. 打开 DBX → 插件中心 → 设置，勾选「允许安装未签名开发包」
3. 导入 `.dbxp`（插件中心 → 安装 / 导入本地包）
4. 插件中心 → 已安装，打开「SQL 练习场」

修改代码后重新打包：

```
npx @dbx-app/plugin-cli package . --target universal
```

## 功能

- 50 道力扣高频 SQL 题，分简单 / 中等 / 困难，可筛选
- 每题自带建表语句和测试数据，打开就能写
- 每题标了考察点（如「窗口函数」「NULL 处理」），带一句思路提示，**答错会自动展开提示**
- 「运行」看结果，「检查答案」判对错
- 判题不比对 SQL 文本，而是**分别执行你的 SQL 和标准答案，比较结果集**，写法不同但结果对就算过
- 进度存在本地，关闭再开还在

## 体积与启动

| | |
|---|---|
| 安装包 | 约 5 MB |
| 插件目录 | 约 7.4 MB |
| 启动 | 约 3-5 秒 |

体积主要来自 PostgreSQL 引擎：`pglite.wasm` 原始 8.7 MB，gzip + base64 后约 4.2 MB。

## 结构

```
manifest.json              插件清单
dbx-plugin.toml            打包配置（include: assets, ui）
ui/index.html              界面
ui/app.js                  判题逻辑
ui/style.css               样式
ui/questions.js            题库（50 题，由构建脚本生成）
ui/vendor/pglite-bundle.js PGlite 的 JS 部分（esbuild 打包）
ui/vendor/pglite-assets.js PostgreSQL 的 wasm 和数据文件（gzip + base64）
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

## 题库从哪来

[Camio1945/leetcode-study-plan-top-sql-50](https://github.com/Camio1945/leetcode-study-plan-top-sql-50)，MIT 协议，许可证见 `tools/upstream/LICENSE`。

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

## 已知限制

- 只支持 PostgreSQL 方言。SQLite 专有写法（如 `date(d, '+1 day')`）会直接报错——这是刻意的，和真实数据库行为一致。
- 判题按「列名 + 行集合」比较，不要求行顺序，浮点按 6 位小数容差。
- 没有做「在你已打开的 DuckDB/MySQL 连接上跑」的模式。
- 首次打开要等 3-5 秒，是在解压和编译 PG 引擎，不是卡死。
