# 题库与引擎构建

插件的题库和 PostgreSQL 引擎都是脚本生成的，这里放的是全套流程。

## 三条命令重建题库

```bash
python -I tools/parse_bank_pg.py    # 解析 + MySQL→PostgreSQL 转换
node tools/verify_pg.mjs            # 用 PGlite 逐题实跑，应输出 total=50 ok=50
python -I tools/render_bank.py      # 合并标题/难度/题面/提示，生成 ui/questions.js
```

第二步是关键：它不是语法检查，而是真的建表、灌数据、执行每道题的标准答案，跑不出结果就报错。

## 引擎资源

```bash
npm run bundle:engine   # esbuild 打包 PGlite 的 JS 部分
npm run build:vendor    # wasm 与数据文件 gzip+base64 内联
```

第一条命令在 Windows 上需要手动补一个参数（npm 会吞掉引号）：

```bash
npx esbuild pg_entry.js --bundle --format=iife --platform=browser ^
  --external:node:* --define:import.meta.url="http://localhost/plugin/" ^
  --outfile=ui/vendor/pglite-bundle.js
```

`--define:import.meta.url` 不能省略：PGlite 内部用它拼 wasm 路径，IIFE 格式下没有这个值会抛 `Invalid URL`。

## 目录

| 文件 | 作用 |
|---|---|
| `upstream/` | 力扣 SQL 50 题的原始 MySQL 版（50 个 .sql + 许可证） |
| `parse_bank_pg.py` | 解析 upstream → PostgreSQL 方言转换 |
| `verify_pg.mjs` | 用 PGlite 实际执行，逐题验证 |
| `render_bank.py` | 加中文标题/难度/题面/提示/考察点，输出 `ui/questions.js` |
| `overrides_pg.json` | 手工修正：自动转换跑不通的题，在这里给改写版 |
| `build_pg_vendor.py` | 把 PG 引擎的 wasm 和数据文件压进一个 JS |
| `pg_probe.mjs` | 手动探针，检查 PGlite 的语法支持 |

中间产物 `raw_questions_pg.json` 已加入 .gitignore，可随时重生成。

## upstream 从哪来

[Camio1945/leetcode-study-plan-top-sql-50](https://github.com/Camio1945/leetcode-study-plan-top-sql-50)，MIT 协议，许可证见 `upstream/LICENSE`。

原仓库是力扣学习计划「高频 SQL 50 题（基础版）」的 MySQL 版，每题一个 .sql 文件，含建表语句、测试数据和参考答案。

## MySQL → PostgreSQL 改了什么

`parse_bank_pg.py` 里的 `convert()`：

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

转换后仍有 4 题跑不通（双引号字符串被当成标识符、VARCHAR 与 INT 比较、HAVING 引用别名、正则转义），在 `overrides_pg.json` 里逐题给出改写版。

## 加题 / 改题

1. 把题目 .sql 放进 `upstream/`（保持三段结构：注释 / 建表+数据 / `/*---*/` / 答案）
2. 跑 `parse_bank_pg.py` + `verify_pg.mjs`，看是否 `ok`
3. 跑不通就在 `overrides_pg.json` 里加改写
4. 在 `render_bank.py` 的 `LC` / `SLUG` / `DESC` / `HINT` / `TOPIC` 里补信息
5. 跑 `render_bank.py`，重新打包

注意：`LC` 里的 key 是题序（1-50），不是力扣题号。
