#!/usr/bin/env bash
# Unit cases for migration-lock-check.py: the lock_timeout rule, the
# CREATE INDEX CONCURRENTLY rule, the NOT NULL-without-DEFAULT rule, what is
# exempt, and --since grandfathering.
#   bash actions/check-migration-locks/check.test.sh
# Run by scripts/shared-actions.test.sh (self-check.yml and the degraded-mode replica).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/migration-lock-check.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

t() {
  local want="$1" sql="$2" got
  printf '%s' "$sql" | python3 "$CHECK" - >/dev/null 2>&1
  got=$?
  [ "$got" = "$want" ] || { echo "FAIL: want $want got $got for: $sql"; fail=1; }
}

# A heavy lock on an existing table needs a lock_timeout BEFORE it.
t 1 'ALTER TABLE "User" ADD COLUMN "x" TEXT;'
t 0 "SET LOCAL lock_timeout = '5s'; ALTER TABLE \"User\" ADD COLUMN \"x\" TEXT;"
t 1 "ALTER TABLE \"User\" ADD COLUMN \"x\" TEXT; SET LOCAL lock_timeout = '5s';"
t 1 'DROP INDEX "User_a_idx";'
t 1 'CREATE UNIQUE INDEX "User_e_key" ON "public"."User"("e");'
# Tables the migration creates cannot be contended — unless a foreign key reaches out.
t 0 'CREATE TABLE "W" ("id" TEXT); CREATE INDEX "W_a_idx" ON "W"("a");'
t 0 'CREATE TABLE "W" ("id" TEXT); CREATE TABLE "V" ("w" TEXT); ALTER TABLE "V" ADD CONSTRAINT "f" FOREIGN KEY ("w") REFERENCES "W"("id");'
t 1 'CREATE TABLE "W" ("id" TEXT); ALTER TABLE "W" ADD CONSTRAINT "f" FOREIGN KEY ("u") REFERENCES "User"("id");'
t 1 'CREATE TABLE "W" ("id" TEXT); CREATE INDEX "U_a_idx" ON "User"("a");'
# CONCURRENTLY stands alone, with no prefix.
t 0 'CREATE INDEX CONCURRENTLY "U_a_idx" ON "User"("a");'
t 0 'DROP INDEX CONCURRENTLY "U_a_idx";'
t 1 "SET LOCAL lock_timeout = '5s'; CREATE INDEX CONCURRENTLY \"U_a_idx\" ON \"User\"(\"a\");"
# Comments, string literals and dollar-quoted bodies are not statements.
t 0 '-- ALTER TABLE "User" in a comment
CREATE TABLE "Z" ("id" TEXT);'
t 0 "INSERT INTO t VALUES ('ALTER TABLE x;');"
t 0 'CREATE FUNCTION f() RETURNS void AS $$ BEGIN ALTER TABLE x ADD y int; END $$ LANGUAGE plpgsql;'

# ADD COLUMN ... NOT NULL on an existing table needs a DEFAULT, whatever the lock_timeout says.
LT="SET LOCAL lock_timeout = '5s';"
t 1 "$LT ALTER TABLE \"User\" ADD COLUMN \"x\" TEXT NOT NULL;"
t 0 "$LT ALTER TABLE \"User\" ADD COLUMN \"x\" TEXT NOT NULL DEFAULT 'a';"
t 0 "$LT ALTER TABLE \"User\" ADD COLUMN \"x\" INTEGER NOT NULL GENERATED ALWAYS AS (1) STORED;"
t 0 "$LT ALTER TABLE \"User\" ADD COLUMN \"x\" TEXT;"
# Postgres accepts ADD without COLUMN; the rule still applies.
t 1 "$LT ALTER TABLE \"User\" ADD \"x\" TEXT NOT NULL;"
# One bad clause among good ones; a comma inside a type's parentheses is not a clause boundary.
t 1 "$LT ALTER TABLE \"User\" ADD COLUMN \"a\" NUMERIC(10,2) NOT NULL DEFAULT 0, ADD COLUMN \"b\" TIMESTAMP(3) NOT NULL;"
t 0 "$LT ALTER TABLE \"User\" ADD COLUMN \"a\" NUMERIC(10,2) NOT NULL DEFAULT 0, ADD COLUMN \"b\" TEXT;"
# The DEFAULT must be on the NOT NULL clause itself, not a sibling.
t 1 "$LT ALTER TABLE \"User\" ADD COLUMN \"a\" TEXT DEFAULT 'x', ADD COLUMN \"b\" TEXT NOT NULL;"
# A constraint mentioning NOT NULL is not a column, and ALTER COLUMN SET NOT NULL is not ADD COLUMN.
t 0 "$LT ALTER TABLE \"User\" ADD CONSTRAINT \"c\" CHECK (\"x\" IS NOT NULL) NOT VALID;"
# A table the migration creates holds no rows.
t 0 'CREATE TABLE "W" ("id" TEXT); ALTER TABLE "W" ADD COLUMN "x" TEXT NOT NULL;'
# The rule fires even where the lock rule is satisfied, and both report on one migration.
out="$(printf '%s' 'ALTER TABLE "User" ADD COLUMN "x" TEXT NOT NULL;' | python3 "$CHECK" - 2>&1 >/dev/null)"
[ "$(printf '%s\n' "$out" | grep -c .)" = 2 ] || { echo "FAIL: expected a lock_timeout and a NOT NULL violation, got: $out"; fail=1; }

# --since skips migrations older than the cutoff, by directory timestamp.
mkdir -p "$TMP/m/20250101093722_old" "$TMP/m/20260901093722_new"
echo 'ALTER TABLE "User" ADD COLUMN "a" TEXT;' > "$TMP/m/20250101093722_old/migration.sql"
echo 'ALTER TABLE "User" ADD COLUMN "b" TEXT;' > "$TMP/m/20260901093722_new/migration.sql"
python3 "$CHECK" --since 20260101000000 "$TMP/m/20250101093722_old/migration.sql" >/dev/null 2>&1 \
  || { echo "FAIL: --since did not skip an older migration"; fail=1; }
python3 "$CHECK" --since 20260101000000 "$TMP"/m/*/migration.sql >/dev/null 2>&1
[ $? = 1 ] || { echo "FAIL: --since skipped a newer migration"; fail=1; }
python3 "$CHECK" --since 2026 - </dev/null >/dev/null 2>&1
[ $? = 2 ] || { echo "FAIL: a malformed --since was not a usage error"; fail=1; }

[ "$fail" = 0 ] && echo "migration-lock-check: all cases passed"
exit "$fail"
