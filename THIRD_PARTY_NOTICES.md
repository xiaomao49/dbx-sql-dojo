# 第三方组件与许可声明

本插件（`com.xiaomao49.sql-dojo`）自身以 MIT 许可发布，许可原文见包内 `LICENSE`。

下面列出随安装包分发的第三方作品、它们各自的许可证，以及完整许可文本在包内的位置。

## 1. PGlite 0.5.13 — Apache License 2.0

- 项目：`@electric-sql/pglite`（<https://github.com/electric-sql/pglite>），作者 Electric DB Limited
- 许可：Apache License 2.0
- 包内文件：`ui/vendor/pglite-bundle.js`、`ui/vendor/pglite-assets.js`
  （后者是 `pglite.wasm`、`initdb.wasm`、`pglite.data` 经 gzip + base64 内联的结果）
- 改动说明：未修改 PGlite 源代码，仅做打包与内联——用 esbuild 打成 IIFE，并把 wasm 与数据文件
  gzip 后内联进 `pglite-assets.js`，运行时用 `DecompressionStream` 解压后交给 PGlite。构建脚本见
  `tools/bundle_engine.mjs` 与 `tools/build_pg_vendor.py`。
- 许可原文：`licenses/Apache-2.0.txt`
- 版权与署名：Apache License 2.0 第 4 条要求随分发保留上述版权、许可与归属声明。

## 2. PostgreSQL 18.6 — PostgreSQL License

- 项目：PostgreSQL 数据库管理系统（<https://www.postgresql.org/>）
- 许可：PostgreSQL License（BSD 风格的宽松许可）
- 包内形式：PostgreSQL 内核被编译成 WebAssembly 后随 PGlite 分发，字节位于
  `ui/vendor/pglite-assets.js` 的 `pglite.wasm` / `pglite.data` 中（运行时自报版本串为
  `PostgreSQL 18.6 (PGlite 0.5.13)`）
- 许可原文：`licenses/PostgreSQL-License.txt`

## 3. 题库 — MIT

- 项目：`Camio1945/leetcode-study-plan-top-sql-50`（<https://github.com/Camio1945/leetcode-study-plan-top-sql-50>）
- 许可：MIT
- 使用方式：保留原仓库的建表语句与测试数据，改写为 PostgreSQL 方言；中文题面、考察点标签与
  思路提示由本插件编写，不整段转载力扣原文。
- 产物：`ui/questions.js`
- 许可原文：`licenses/question-bank-MIT.txt`

## 4. 本插件自身

MIT，见包内 `LICENSE`。题目文本的著作权归力扣（LeetCode）；本插件只提供自写的中文释义与练习环境。
