# 题库构建脚本

题库不是手写的，是从开源题库解析、转换、验证出来的。这里放的就是这套流程。

## 两步走

```bash
python -I tools/parse_bank.py    # 解析 + MySQL→SQLite 转换 + 逐题验证
python -I tools/render_bank.py   # 合并标题/难度/中文题面，生成 ui/questions.js
```

第一步会打印 `total=50 ok=50`，表示 50 道题的建表、测试数据和标准答案在 SQLite 上都能跑通。
第二步直接覆盖 `ui/questions.js`，随后重新打包插件即可。

中间产物 `tools/raw_questions.json` 已加入 .gitignore，可随时重生成。

## 目录

| 文件 | 作用 |
|---|---|
| `upstream/` | 力扣 SQL 50 题的原始 MySQL 版（50 个 .sql + 许可证） |
| `overrides.json` | 手工修正：SQLite 跑不通的题，在这里给出改写后的建表或答案 |
| `parse_bank.py` | 解析 upstream → 方言转换 → 用 SQLite 实跑验证 |
| `render_bank.py` | 加中文标题/难度/题面，输出插件用的 questions.js |

## upstream 从哪来

[Camio1945/leetcode-study-plan-top-sql-50](https://github.com/Camio1945/leetcode-study-plan-top-sql-50)，MIT 协议，许可证见 `upstream/LICENSE`。

原仓库是力扣学习计划「高频 SQL 50 题（基础版）」的 MySQL 版，每题一个 .sql 文件，含建表语句、测试数据和参考答案。文件名里带 `[erred]` / `[improved]` 的是原作者的标注。

## 改写都做了什么

`parse_bank.py` 里的 `convert()` 处理 MySQL → SQLite 的差异：

- `ENUM(...)` → `TEXT`
- `TRUNCATE TABLE x` → `DELETE FROM x`
- 反引号 → 双引号
- `IF(cond, a, b)` → `CASE WHEN ... THEN ... ELSE ... END`
- `DATE_ADD/DATE_SUB(x, INTERVAL n DAY)` → `date(x, '+n day')`
- `LEFT(x, n)` → `substr(x, 1, n)`
- `DATE_FORMAT` / `CONCAT` → `strftime` / `||`
- `DROP TABLE a, b` → 拆成多条

转换后仍有 11 题跑不通（日期函数、自增主键、`REGEXP`、`LIMIT offset,count`、原文写错的 `group_distinct` 等），这些在 `overrides.json` 里逐题给出了改写版。

## 加题 / 改题

1. 把新题目的 .sql 放进 `upstream/`（保持同样的三段结构：注释 / 建表+数据 / `/*---*/` / 答案）
2. 跑 `parse_bank.py`，看是否 `ok`
3. 跑不通就在 `overrides.json` 里加一条改写
4. 在 `render_bank.py` 的 `LC` / `SLUG` / `DESC` 三个字典里补上新题的信息
5. 跑 `render_bank.py`，重新打包

注意：`LC` 里的 key 是题序（1-50），不是力扣题号。
