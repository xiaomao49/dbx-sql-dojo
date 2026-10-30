# SQL 练习场（DBX 插件）

在 DBX 里刷力扣高频 SQL 50 题。题库、判题都在本地跑，不联网、不用配置数据库连接。

## 安装

1. 打包好的安装包在 `dist/com.mashidong.sql-dojo-0.1.0-universal.dbxp`
2. 打开 DBX → 插件中心 → 设置，勾选「允许安装未签名开发包」
3. 导入上面的 `.dbxp` 文件（插件中心 → 安装 / 导入本地包）
4. 插件中心 → 已安装，能看到「SQL 练习场」；侧边栏或插件入口打开工作台

修改代码后重新打包：

```
npx @dbx-app/plugin-cli package . --target universal
```

## 功能

- 50 道力扣高频 SQL 题，分简单 / 中等 / 困难，可筛选
- 每题自带建表语句和测试数据，打开就能写
- 「运行」看结果，「检查答案」判对错
- 判题不比对 SQL 文本，而是**分别执行你的 SQL 和标准答案，比较结果集**，写法不同但结果对就算过
- 进度存在本地，关闭再开还在

## 结构

```
manifest.json        插件清单
dbx-plugin.toml      打包配置（include: assets, ui）
ui/index.html        界面
ui/app.js            判题逻辑
ui/style.css         样式
ui/questions.json    题库（50 题，由构建脚本生成）
ui/vendor/sql-wasm.* sql.js，浏览器里的 SQLite
```

## 题库是怎么来的

- 题目和答案：[Camio1945/leetcode-study-plan-top-sql-50](https://github.com/Camio1945/leetcode-study-plan-top-sql-50)（MIT），力扣 SQL 50 的 MySQL 版，含建表、测试数据、参考答案
- 标题和难度：力扣题库接口
- 中文题面：本插件自己写的简述（不整段转载力扣原文）

构建脚本在 `tools/`：`parse_bank.py` 负责解析 + MySQL→SQLite 转换 + 逐题验证，`render_bank.py` 负责合并标题/难度/题面并生成 `ui/questions.js`。详见 [tools/README.md](tools/README.md)。

## 已知限制

- 跑的是 SQLite 方言（sql.js），不是 MySQL。原题里的 `ENUM`、`TRUNCATE`、`DATE_ADD`、`REGEXP` 等已在构建时改写，少数题的标准答案是按 SQLite 重写的。
- 目前只支持内置 SQLite，还没做「在你自己已打开的 DuckDB/MySQL 连接上跑」的模式。
- 判题按「列名 + 行集合」比较，不要求行顺序，浮点按 6 位小数容差。
