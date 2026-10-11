#!/usr/bin/env python3
"""Check Prisma migration SQL against the lock and unsafe-DDL rules.

    migration-lock-check.py [--since YYYYMMDDHHMMSS] <migration.sql>... | -

1. A statement that takes a heavy lock (ALTER TABLE, DROP, a plain CREATE INDEX)
   on a table that already exists must come after `SET LOCAL lock_timeout`.
   Statements that touch only tables the same migration creates are exempt:
   nothing else can hold a lock on a table that did not exist. A foreign key
   counts as touching the table it references.
2. `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` is the only statement
   in its migration and carries no lock_timeout prefix: a second statement puts
   it inside Prisma's implicit transaction, where Postgres refuses it.
3. `ALTER TABLE ... ADD COLUMN ... NOT NULL` on a table that already exists
   carries a `DEFAULT` (or is `GENERATED`). Migrations run before the new code
   is live, against every row the table already holds; on a non-empty table the
   statement fails mid-deploy. Add the column nullable, backfill, and set
   `NOT NULL` a deploy later, or give it a default.

`-` reads one migration from stdin (the PreToolUse hook's path). `--since`
skips any file whose migration directory timestamp sorts before it, so a repo
can adopt the check in CI without rewriting checksum-locked history.
Exit 0 clean, 1 on a violation (each printed to stderr), 2 on bad usage.

Vendored in GarrettMakesItLLC/ci so the action carries no run-time fetch; it
started as dotclaude's `bin/migration-lock-check.py`, which its write-time
migration-guard hook still runs.
"""

import os
import re
import sys

HEAVY = re.compile(r"^(ALTER\s+TABLE|DROP\s|CREATE\s+(UNIQUE\s+)?INDEX\s)", re.I)
CONCURRENT = re.compile(r"^(CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+CONCURRENTLY\b", re.I)
LOCK_TIMEOUT = re.compile(r"^SET\s+LOCAL\s+lock_timeout\b", re.I)
CREATE_TABLE = re.compile(r"^CREATE\s+(UNLOGGED\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(\S+)", re.I)
ALTER_TARGET = re.compile(r"^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?(\S+)", re.I)
INDEX_TARGET = re.compile(r"\sON\s+(ONLY\s+)?(\S+)", re.I)
REFERENCES = re.compile(r"\sREFERENCES\s+(\S+)", re.I)
# `ADD COLUMN x` or the bare `ADD x` Postgres also accepts — never `ADD CONSTRAINT ... CHECK (x IS NOT NULL)`.
ADD_COLUMN = re.compile(r"^ADD\s+(COLUMN\s|(?!(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b)\S)", re.I)
NOT_NULL = re.compile(r"\bNOT\s+NULL\b", re.I)
DEFAULT = re.compile(r"\bDEFAULT\b", re.I)
GENERATED = re.compile(r"\bGENERATED\b", re.I)
TIMESTAMP_DIR = re.compile(r"(?:^|/)(\d{14})_[^/]*/[^/]*$")


def strip_sql(sql: str) -> str:
    """Blank comments, string literals and dollar-quoted bodies, keeping `"identifiers"`."""
    out, i, n = [], 0, len(sql)
    while i < n:
        if sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j == -1 else j
        elif sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            i = n if j == -1 else j + 2
        elif sql[i] == "'":
            j = i + 1
            while j < n and not (sql[j] == "'" and not sql.startswith("''", j)):
                j += 2 if sql.startswith("''", j) else 1
            out.append("''")
            i = j + 1
        elif sql[i] == "$":
            m = re.match(r"\$[A-Za-z_]*\$", sql[i:])
            if m:
                tag = m.group(0)
                j = sql.find(tag, i + len(tag))
                out.append("$$")
                i = n if j == -1 else j + len(tag)
            else:
                out.append("$")
                i += 1
        else:
            out.append(sql[i])
            i += 1
    return "".join(out)


def statements(sql: str) -> list[str]:
    return [" ".join(s.split()) for s in strip_sql(sql).split(";") if s.strip()]


def table_name(raw: str) -> str:
    """`"public"."Widget"` and `Widget` name the same table for this purpose."""
    return raw.split("(")[0].split(".")[-1].strip('"')


def target(stmt: str) -> str | None:
    m = ALTER_TARGET.match(stmt)
    if m:
        return table_name(m.group(3))
    if re.match(r"^CREATE\s+(UNIQUE\s+)?INDEX\s", stmt, re.I):
        m = INDEX_TARGET.search(stmt)
        return table_name(m.group(2)) if m else None
    m = re.match(r"^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?(\S+)", stmt, re.I)
    return table_name(m.group(2)) if m else None


def top_level_commas(text: str) -> list[str]:
    """Split on commas outside parentheses: `ADD COLUMN "a" NUMERIC(10,2), ADD ...` is two clauses."""
    parts, depth, start = [], 0, 0
    for i, ch in enumerate(text):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(text[start:i].strip())
            start = i + 1
    parts.append(text[start:].strip())
    return [p for p in parts if p]


def not_null_without_default(stmts: list[str], created: set[str]) -> list[str]:
    found = []
    for stmt in stmts:
        m = ALTER_TARGET.match(stmt)
        if not m or table_name(m.group(3)) in created:
            continue
        for clause in top_level_commas(stmt[m.end():]):
            if not ADD_COLUMN.match(clause) or not NOT_NULL.search(clause):
                continue
            # A DEFAULT satisfies every existing row the instant the constraint lands, and a
            # generated column computes its own value for each of them.
            if DEFAULT.search(clause) or GENERATED.search(clause):
                continue
            found.append(
                f"`{clause[:80]}` adds a NOT NULL column with no DEFAULT to an existing table. "
                "The migration runs before the new code is live, against every row the table "
                "already holds, so on a non-empty table it fails mid-deploy. Add it nullable, "
                "backfill, and set NOT NULL in a later migration — or give it a DEFAULT."
            )
    return found


def violations(sql: str) -> list[str]:
    stmts = statements(sql)
    if any(CONCURRENT.match(s) for s in stmts):
        found = []
        if len(stmts) > 1:
            found.append(
                "CREATE/DROP INDEX CONCURRENTLY must be the only statement in its migration — "
                "a second statement puts it inside a transaction, where Postgres refuses it. "
                "Split it into its own migration (with no lock_timeout prefix)."
            )
        return found

    created = {table_name(m.group(3)) for s in stmts if (m := CREATE_TABLE.match(s))}
    return lock_timeout_violations(stmts, created) + not_null_without_default(stmts, created)


def lock_timeout_violations(stmts: list[str], created: set[str]) -> list[str]:
    for idx, stmt in enumerate(stmts):
        if not HEAVY.match(stmt):
            continue
        # A foreign key also locks the table it REFERENCES (SHARE ROW EXCLUSIVE, which queues
        # writes behind it), so a new table pointing at an existing one is not exempt.
        touched = {target(stmt)} | {table_name(r) for r in REFERENCES.findall(stmt)}
        if touched <= created:
            continue
        if any(LOCK_TIMEOUT.match(s) for s in stmts[:idx]):
            return []
        return [
            f"`{stmt[:80]}` takes a heavy lock on an existing table with no "
            "`SET LOCAL lock_timeout = '5s';` before it. A pending ACCESS EXCLUSIVE request "
            "queues every read the old server is still serving, so the table is down until "
            "the migration gets its lock; bounded, the migration fails and the site stays up. "
            "Open the migration with `SET LOCAL lock_timeout = '5s';` (rules/prisma.md)."
        ]
    return []


def main(argv: list[str]) -> int:
    since = None
    if len(argv) >= 2 and argv[0] == "--since":
        since, argv = argv[1], argv[2:]
        if not re.fullmatch(r"\d{14}", since):
            print("--since takes a 14-digit migration timestamp", file=sys.stderr)
            return 2
    if not argv:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2

    bad = 0
    for path in argv:
        if path == "-":
            sql, label = sys.stdin.read(), "migration"
        else:
            m = TIMESTAMP_DIR.search(os.path.abspath(path))
            if since and m and m.group(1) < since:
                continue
            with open(path, encoding="utf-8") as f:
                sql, label = f.read(), path
        for v in violations(sql):
            print(f"{label}: {v}", file=sys.stderr)
            bad = 1
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
