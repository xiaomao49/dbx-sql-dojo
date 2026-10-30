"""Parse the LeetCode SQL-50 bank and convert MySQL -> PostgreSQL (for PGlite)."""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "upstream")
OUT = os.path.join(ROOT, "tools", "raw_questions_pg.json")
OVERRIDES = os.path.join(ROOT, "tools", "overrides_pg.json")


def find_matching(s, start):
    depth = 0
    for i in range(start, len(s)):
        if s[i] == '(':
            depth += 1
        elif s[i] == ')':
            depth -= 1
            if depth == 0:
                return i
    return -1


def split_top(inner):
    parts, depth, cur = [], 0, ''
    for ch in inner:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += ch
    parts.append(cur)
    return parts


def rewrite_call(s, fname, arity, render, recursive=False):
    """Rewrite fname(...) calls with the given arity, matching nested parens and any whitespace."""
    pattern = re.compile(r'\b' + re.escape(fname) + r'\s*\(', re.I)
    out, pos = [], 0
    while True:
        m = pattern.search(s, pos)
        if not m:
            out.append(s[pos:])
            break
        out.append(s[pos:m.start()])
        paren = s.index('(', m.start())
        end = find_matching(s, paren)
        if end == -1:
            out.append(s[m.start():])
            break
        parts = split_top(s[paren + 1:end])
        if len(parts) == arity:
            args = [p.strip() for p in parts]
            if recursive:
                args = [rewrite_call(a, fname, arity, render, True) for a in args]
            out.append(render(*args))
            pos = end + 1
        else:
            out.append(s[m.start():paren + 1])
            pos = paren + 1
    return ''.join(out)


def group_concat(x):
    x = x.strip()
    if x.lower().startswith('distinct'):
        return f"string_agg(distinct ({x[8:].strip()})::text, ',')"
    return f"string_agg(({x})::text, ',')"


def convert(sql):
    s = sql
    # INTERVAL 1 DAY -> interval '1 day'
    s = re.sub(r"INTERVAL\s+(\d+)\s+(DAY|MONTH|YEAR|HOUR|MINUTE|SECOND)", r"interval '\1 \2'", s, flags=re.I)
    # FLOAT(n, m) -> numeric(n, m)
    s = re.sub(r'\bFLOAT\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)', r'numeric(\1, \2)', s, flags=re.I)
    # 无参数的 FLOAT -> real
    s = re.sub(r'\bFLOAT\b(?!\s*\()', 'real', s, flags=re.I)
    # ENUM(...) -> text
    s = re.sub(r'\bENUM\s*\([^)]*\)', 'text', s, flags=re.I)
    s = re.sub(r'\bDATETIME\b', 'timestamp', s, flags=re.I)
    s = re.sub(r'\bAUTO_INCREMENT\b', '', s, flags=re.I)
    s = s.replace('`', '"')

    # IF(cond, a, b) -> CASE WHEN
    s = rewrite_call(s, 'IF', 3, lambda c, a, b: f'(CASE WHEN {c} THEN {a} ELSE {b} END)', recursive=True)
    # IFNULL(a, b) -> coalesce(a, b)
    s = rewrite_call(s, 'IFNULL', 2, lambda a, b: f'coalesce({a}, {b})')
    # DATE_ADD/DATE_SUB(x, interval '...') -> (x::timestamp +/- interval)
    s = rewrite_call(s, 'DATE_ADD', 2, lambda x, i: f'(({x})::timestamp + {i})')
    s = rewrite_call(s, 'DATE_SUB', 2, lambda x, i: f'(({x})::timestamp - {i})')
    # ROUND(x, n) -> round((x)::numeric, n)
    s = rewrite_call(s, 'ROUND', 2, lambda x, n: f'round(({x})::numeric, {n})')
    # LEFT(x, n) -> left((x)::text, n)
    s = rewrite_call(s, 'LEFT', 2, lambda x, n: f'left(({x})::text, {n})')
    # DATE_FORMAT(x, '%Y-%m') -> to_char(x, 'YYYY-MM')
    def fmt(x, pat):
        p = pat.replace('%Y', 'YYYY').replace('%m', 'MM').replace('%d', 'DD')
        return f"to_char({x}, '{p}')"
    s = rewrite_call(s, 'DATE_FORMAT', 2, fmt)
    # GROUP_CONCAT(x) -> string_agg(x::text, ',')
    s = rewrite_call(s, 'GROUP_CONCAT', 1, group_concat)
    # REGEXP -> ~
    s = re.sub(r"\bREGEXP\b", "~", s, flags=re.I)
    # LIMIT n, m -> LIMIT m OFFSET n
    s = re.sub(r'\bLIMIT\s+(\d+)\s*,\s*(\d+)', r'LIMIT \2 OFFSET \1', s, flags=re.I)
    return s


def parse_file(path):
    raw = open(path, encoding='utf-8').read()
    lines = raw.splitlines()
    body = '\n'.join(l for l in lines if not l.lstrip().startswith('#'))
    if '/*---' in body:
        setup, answer = body.split('/*---', 1)
        answer = answer.split('*/', 1)[1] if '*/' in answer else answer
    else:
        setup, answer = body, ''
    return setup.strip(), answer.strip()


def main():
    ov = json.load(open(OVERRIDES, encoding='utf-8')) if os.path.exists(OVERRIDES) else {}
    rows = []
    for name in sorted(os.listdir(SRC)):
        if not name.endswith('.sql'):
            continue
        num = int(re.search(r'50-(\d+)', name).group(1))
        setup, answer = parse_file(os.path.join(SRC, name))
        o = ov.get(str(num), {})
        setup_pg = o.get('setup', convert(setup))
        answer_pg = o.get('answer', convert(answer))
        body = re.sub(r'/\*.*?\*/', '', answer_pg, flags=re.S).strip()
        qtype = 'dml' if re.match(r'(delete|update|insert)\b', body, re.I) else 'select'
        rows.append({
            'id': num,
            'file': name,
            'setup': setup_pg,
            'answer': answer_pg,
            'type': qtype,
        })
    json.dump(rows, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'wrote {len(rows)} questions -> {OUT}')


if __name__ == '__main__':
    main()
