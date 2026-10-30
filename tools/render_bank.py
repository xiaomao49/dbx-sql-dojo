"""Merge the verified bank with LeetCode metadata, produce questions.json for the plugin."""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "tools", "raw_questions.json")
OUT = os.path.join(ROOT, "ui", "questions.js")

# id: (leetcode_id, 中文标题, 难度)
LC = {
    1: (1757, "可回收且低脂的产品", "Easy"),
    2: (584, "寻找用户推荐人", "Easy"),
    3: (595, "大的国家", "Easy"),
    4: (1148, "文章浏览 I", "Easy"),
    5: (1683, "无效的推文", "Easy"),
    6: (1378, "使用唯一标识码替换员工ID", "Easy"),
    7: (1068, "产品销售分析 I", "Easy"),
    8: (1581, "进店却未进行过交易的顾客", "Easy"),
    9: (197, "上升的温度", "Easy"),
    10: (1661, "每台机器的进程平均运行时间", "Easy"),
    11: (577, "员工奖金", "Easy"),
    12: (1280, "学生们参加各科测试的次数", "Easy"),
    13: (570, "至少有5名直接下属的经理", "Medium"),
    14: (1934, "确认率", "Medium"),
    15: (620, "有趣的电影", "Easy"),
    16: (1251, "平均售价", "Easy"),
    17: (1075, "项目员工 I", "Easy"),
    18: (1633, "各赛事的用户注册率", "Easy"),
    19: (1211, "查询结果的质量和占比", "Easy"),
    20: (1193, "每月交易 I", "Medium"),
    21: (1174, "即时食物配送 II", "Medium"),
    22: (550, "游戏玩法分析 IV", "Medium"),
    23: (2356, "每位教师所教授的科目种类的数量", "Easy"),
    24: (1141, "查询近30天活跃用户数", "Easy"),
    25: (1070, "产品销售分析 III", "Medium"),
    26: (596, "超过5名学生的课", "Easy"),
    27: (1729, "求关注者的数量", "Easy"),
    28: (619, "只出现一次的最大数字", "Easy"),
    29: (1045, "买下所有产品的客户", "Medium"),
    30: (1731, "每位经理的下属员工数量", "Easy"),
    31: (1789, "员工的直属部门", "Easy"),
    32: (610, "判断三角形", "Easy"),
    33: (180, "连续出现的数字", "Medium"),
    34: (1164, "指定日期的产品价格", "Medium"),
    35: (1204, "最后一个能进入巴士的人", "Medium"),
    36: (1907, "按分类统计薪水", "Medium"),
    37: (1978, "上级经理已离职的公司员工", "Easy"),
    38: (626, "换座位", "Medium"),
    39: (1341, "电影评分", "Medium"),
    40: (1321, "餐馆营业额变化增长", "Medium"),
    41: (602, "好友申请 II ：谁有最多的好友", "Medium"),
    42: (585, "2016年的投资", "Medium"),
    43: (185, "部门工资前三高的所有员工", "Hard"),
    44: (1667, "修复表中的名字", "Easy"),
    45: (1527, "患某种疾病的患者", "Easy"),
    46: (196, "删除重复的电子邮箱", "Easy"),
    47: (176, "第二高的薪水", "Medium"),
    48: (1484, "按日期分组销售产品", "Easy"),
    49: (1327, "列出指定时间段内所有的下单产品", "Easy"),
    50: (1517, "查找拥有有效邮箱的用户", "Easy"),
}

SLUG = {
    1: "recyclable-and-low-fat-products", 2: "find-customer-referee", 3: "big-countries",
    4: "article-views-i", 5: "invalid-tweets", 6: "replace-employee-id-with-the-unique-identifier",
    7: "product-sales-analysis-i", 8: "customer-who-visited-but-did-not-make-any-transactions",
    9: "rising-temperature", 10: "average-time-of-process-per-machine", 11: "employee-bonus",
    12: "students-and-examinations", 13: "managers-with-at-least-5-direct-reports",
    14: "confirmation-rate", 15: "not-boring-movies", 16: "average-selling-price",
    17: "project-employees-i", 18: "percentage-of-users-attended-a-contest",
    19: "queries-quality-and-percentage", 20: "monthly-transactions-i",
    21: "immediate-food-delivery-ii", 22: "game-play-analysis-iv",
    23: "number-of-unique-subjects-taught-by-each-teacher",
    24: "user-activity-for-the-past-30-days-i", 25: "product-sales-analysis-iii",
    26: "classes-more-than-5-students", 27: "find-followers-count", 28: "biggest-single-number",
    29: "customers-who-bought-all-products",
    30: "the-number-of-employees-which-report-to-each-employee",
    31: "primary-department-for-each-employee", 32: "triangle-judgement",
    33: "consecutive-numbers", 34: "product-price-at-a-given-date",
    35: "last-person-to-fit-in-the-bus", 36: "count-salary-categories",
    37: "employees-whose-manager-left-the-company", 38: "exchange-seats", 39: "movie-rating",
    40: "restaurant-growth", 41: "friend-requests-ii-who-has-the-most-friends",
    42: "investments-in-2016", 43: "department-top-three-salaries", 44: "fix-names-in-a-table",
    45: "patients-with-a-condition", 46: "delete-duplicate-emails", 47: "second-highest-salary",
    48: "group-sold-products-by-the-date", 49: "list-the-products-ordered-in-a-period",
    50: "find-users-with-valid-e-mails",
}

DESC = {
    1: "找出既是低脂（low_fats='Y'）又可回收（recyclable='Y'）的产品 ID。",
    2: "找出没有被 ID 为 2 的用户推荐过的用户名字。",
    3: "找出面积 ≥ 300 万 km² 或人口 ≥ 2500 万的「大国」，返回名称、人口、面积。",
    4: "找出浏览过自己文章的作者 ID，按 ID 升序返回。",
    5: "找出内容字符数严格大于 15 的无效推文 ID。",
    6: "用唯一标识表把员工的 ID 换成唯一标识码；没有唯一标识的显示 NULL。",
    7: "返回每笔销售对应的产品名称、年份和价格。",
    8: "找出访问过但一次交易都没做的顾客，以及他们访问的次数。",
    9: "找出比前一天温度更高的那几天的记录 ID。",
    10: "计算每台机器处理一个流程的平均耗时，保留 3 位小数。",
    11: "找出奖金小于 1000 的员工姓名和奖金。",
    12: "统计每个学生每门科目参加考试次数，按学号和科目排序。",
    13: "找出直接下属人数至少 5 人的经理姓名。",
    14: "计算每个用户的确认率（确认次数 / 总确认记录数），保留 2 位小数。",
    15: "找出 ID 为奇数、且描述不是 boring 的电影，按评分降序返回。",
    16: "计算每个产品的平均售价，保留 2 位小数。",
    17: "计算每个项目上员工的平均工作年限，保留 2 位小数。",
    18: "计算每个赛事的用户注册率（保留 2 位小数），按注册率降序、赛事 ID 升序。",
    19: "计算每个查询名称的质量分和劣质查询占比，均保留 2 位小数。",
    20: "按月份和国家统计交易笔数、总金额，以及已批准交易的笔数和金额。",
    21: "在所有客户的首单中，统计「即时订单」的占比，保留 2 位小数。",
    22: "统计首次登录后第二天再次登录的玩家占比，保留 2 位小数。",
    23: "统计每位教师所教的不同科目数量。",
    24: "统计截至 2019-07-27 的最近 30 天内，每天的活跃用户数。",
    25: "找出每个产品首次销售那一年的产品 ID、年份、数量和价格。",
    26: "找出至少有 5 名学生的课程。",
    27: "统计每个用户的关注者数量，按 user_id 升序。",
    28: "找出只出现过一次的最大数字；不存在则返回 NULL。",
    29: "找出买下了 Product 表中全部产品的客户 ID。",
    30: "统计每位经理的直属下属人数和下属平均年龄（四舍五入），按员工 ID 排序。",
    31: "找出每位员工的主部门；只属于一个部门的，直接返回该部门。",
    32: "判断给出的三条边能否构成三角形。",
    33: "找出连续出现至少三次的数字。",
    34: "找出 2019-08-16 当天所有产品的价格；在此之前没有改过价的按 10 算。",
    35: "人们按顺序排队上车，巴士载重上限 1000 公斤，求最后一个能上车的人。",
    36: "把账户按薪水分成 Low / Average / High 三档统计数量，没有账户的档位记 0。",
    37: "找出工资低于 30000、且直属经理已经离职的员工 ID。",
    38: "把相邻两个学生的座位号两两交换；学生数为奇数时最后一个不动。按 ID 升序返回。",
    39: "找出评论电影数量最多的用户；以及 2020 年 2 月平均评分最高的电影。",
    40: "计算每位顾客每天往前 7 天的移动合计金额和平均值，按日期升序。",
    41: "找出好友数量最多的人及其好友数。",
    42: "统计满足条件的投保人在 2016 年的投资总额，保留 2 位小数。",
    43: "找出每个部门工资排名前三的员工。",
    44: "把名字改成首字母大写、其余小写，按 user_id 排序。",
    45: "找出患 I 型糖尿病的患者（conditions 中以 DIAB1 开头的记录）。",
    46: "删除重复的电子邮箱，每个邮箱只保留 ID 最小的那条。",
    47: "找出第二高的薪水；没有第二高时返回 NULL。",
    48: "统计每天售出的不同产品数量，并把产品名去重排序后拼接。",
    49: "找出 2020 年 2 月订单总量至少 100 的产品名称和数量。",
    50: "找出邮箱格式合法的用户：@ 前以字母开头、只含字母数字和 _ . -，域名为 @leetcode.com。",
}


def main():
    rows = json.load(open(RAW, encoding='utf-8'))
    out = []
    for r in rows:
        i = r['id']
        lc_id, title, diff = LC[i]
        out.append({
            'id': i,
            'lcId': lc_id,
            'title': title,
            'difficulty': diff,
            'slug': SLUG[i],
            'desc': DESC[i],
            'setup': r['setup'],
            'answer': r['answer'],
            'type': r['type'],
            'cols': r['cols'],
        })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("window.SQL_DOJO_BANK = ")
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f'wrote {len(out)} questions -> {OUT}')
    print('tables per question:', sorted({m for r in out for m in re.findall(r'CREATE TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)', r['setup'], re.I)}))


if __name__ == '__main__':
    main()
