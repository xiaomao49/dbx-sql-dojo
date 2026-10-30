"""Parse the LeetCode SQL-50 bank, convert MySQL -> SQLite, and verify each answer runs."""
import json
import os
import re
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "upstream")
OUT = os.path.join(ROOT, "tools", "raw_questions.json")


def find_matching(s, start):
    """s[start] == '(' ; return index of matching ')'."""
    depth = 0
    for i in range(start, len(s)):
        c = s[i]
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return i
    return -1


def convert_if(s):
    """Rewrite MySQL IF(cond, a, b) into CASE WHEN cond THEN a ELSE b END."""
    out = []
    i = 0
    low = s.lower()
    while i < len(s):
        if low.startswith('if(', i) or low.startswith('if (', i):
            j = s.find('(', i)
            end = find_matching(s, j)
            if end == -1:
                out.append(s[i])
                i += 1
                continue
            inner = s[j + 1:end]
            # split top-level commas
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
            if len(parts) == 3:
                cond, a, b = parts
                out.append(f'(CASE WHEN {convert_if(cond.strip())} THEN {convert_if(a.strip())} ELSE {convert_if(b.strip())} END)')
                i = end + 1
                continue
        out.append(s[i])
        i += 1
    return ''.join(out)


def convert(sql):
    s = sql
    s = re.sub(r'\bENUM\s*\([^)]*\)', 'TEXT', s, flags=re.I)
    s = re.sub(r'\bTRUNCATE\s+TABLE\s+(\w+)', r'DELETE FROM \1', s, flags=re.I)
    s = re.sub(r'\bDROP\s+TABLE\s+IF\s+EXISTS\s+((?:\w+\s*,\s*)*\w+)',
               lambda m: '; '.join(f'DROP TABLE IF EXISTS {t.strip()}' for t in m.group(1).split(',')),
               s, flags=re.I)
    s = s.replace('`', '"')
    s = convert_if(s)
    # LEFT(x, n) -> substr(x, 1, n)
    s = re.sub(r'\bLEFT\s*\(([^,()]+),\s*(\d+)\s*\)', r'substr(\1, 1, \2)', s, flags=re.I)
    # DATE_FORMAT(x, '%Y-%m') -> strftime('%Y-%m', x)
    s = re.sub(r"DATE_FORMAT\s*\(([^,]+),\s*'([^']+)'\)", r"strftime('\2', \1)", s, flags=re.I)
    # CONCAT(a,b) -> a || b
    s = re.sub(r'CONCAT\s*\(([^()]*)\)', lambda m: ' || '.join(p.strip() for p in m.group(1).split(',')), s, flags=re.I)
    return s


def parse_file(path):
    raw = open(path, encoding='utf-8').read()
    lines = raw.splitlines()
    notes = [l.lstrip('#').strip() for l in lines if l.lstrip().startswith('#') and l.strip() != '#']
    body = '\n'.join(l for l in lines if not l.lstrip().startswith('#'))
    if '/*---' in body:
        setup, answer = body.split('/*---', 1)
        answer = answer.split('*/', 1)[1] if '*/' in answer else answer
    else:
        setup, answer = body, ''
    return notes, setup.strip(), answer.strip()


OVERRIDES = os.path.join(ROOT, "tools", "overrides.json")


def strip_comments(sql):
    return re.sub(r'/\*.*?\*/', '', sql, flags=re.S).strip()


def dump_tables(con):
    names = [r[0] for r in con.execute(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]
    return {t: con.execute(f'select * from "{t}"').fetchall() for t in names}


def main():
    ov = json.load(open(OVERRIDES, encoding='utf-8'))
    rows = []
    for name in sorted(os.listdir(SRC)):
        if not name.endswith('.sql'):
            continue
        num = int(re.search(r'50-(\d+)', name).group(1))
        notes, setup, answer = parse_file(os.path.join(SRC, name))
        setup_c, answer_c = convert(setup), convert(answer)
        o = ov.get(str(num), {})
        setup_c = o.get('setup_sqlite', setup_c)
        answer_c = o.get('answer_sqlite', answer_c)
        qtype = 'dml' if re.match(r'(delete|update|insert)\b', strip_comments(answer_c), re.I) else 'select'

        status, err, cols, sample = 'ok', '', [], []
        try:
            con = sqlite3.connect(':memory:')
            con.executescript(setup_c)
            if qtype == 'dml':
                con.executescript(answer_c)
                result = dump_tables(con)
                if not any(result.values()):
                    status, err = 'empty', 'all tables empty after dml'
                sample = list(result.items())[:1]
            else:
                cur = con.execute(answer_c)
                result = cur.fetchall()
                cols = [d[0] for d in cur.description]
                if not result:
                    status, err = 'empty', 'answer returned 0 rows'
                sample = result[:3]
            con.close()
        except Exception as e:
            status, err = 'fail', str(e)
        rows.append({
            'id': num,
            'file': name,
            'notes': notes,
            'setup': setup_c,
            'answer': answer_c,
            'type': qtype,
            'status': status,
            'error': err,
            'cols': cols,
            'sample': sample,
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(rows, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    ok = [r for r in rows if r['status'] == 'ok']
    print(f'total={len(rows)} ok={len(ok)}')
    for r in rows:
        if r['status'] != 'ok':
            print(f"  {r['id']:>2} {r['status']:<5} {r['error'][:120]}")


if __name__ == '__main__':
    main()
