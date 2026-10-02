// @ts-check
/**
 * Pure rules for what a branch may do to a Prisma `migrations/` directory.
 *
 * Prisma applies migration directories in LEXICOGRAPHIC order and keys applied
 * ones by name, checksumming their SQL. So: a new directory must sort after the
 * newest on base, must not collide, must not be dated in the future, must not
 * sit on a round hour (the collision magnet for concurrent authors), and an
 * existing directory is immutable. The agent-side hook sees a tree as it was when
 * a file was AUTHORED; a branch that sits in review while another migration lands
 * merges out of order unopposed, so CI is the only layer that covers it.
 *
 * Union of four per-product copies: out-of-order, future-dated (with the
 * future-dated-base relaxation), round-hour, duplicate timestamps (with an exact
 * baseline), and immutability of applied migrations.
 */

const MIGRATION_DIR = /^(\d{14})_/;

/** Tolerance for a name typed from a local clock running ahead of UTC. */
const SKEW_MS = 60 * 60 * 1000;

/**
 * @typedef {{ rule: string, dir: string, message: string }} Finding
 * @typedef {{
 *   base: Map<string, string | undefined>,
 *   head: Map<string, string | undefined>,
 *   settled?: Iterable<string>,
 *   nowMs: number,
 *   roundHour?: boolean,
 *   allowRoundHour?: Iterable<string>,
 *   allowCollisions?: string[][],
 *   immutability?: boolean,
 * }} AuditInput
 */

/** @param {Iterable<string>} names */
export function migrationDirs(names) {
  return [...names].filter((n) => MIGRATION_DIR.test(n)).sort();
}

/** A 14-digit `YYYYMMDDHHMMSS` read as UTC, or NaN when it is not a real instant. */
export function timestampMs(ts) {
  const y = Number(ts.slice(0, 4));
  const mo = Number(ts.slice(4, 6));
  const d = Number(ts.slice(6, 8));
  const h = Number(ts.slice(8, 10));
  const mi = Number(ts.slice(10, 12));
  const s = Number(ts.slice(12, 14));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return NaN;
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/**
 * @param {AuditInput} input
 * @returns {{ findings: Finding[], warnings: string[] }}
 */
export function auditMigrations({
  base,
  head,
  settled = [],
  nowMs,
  roundHour = true,
  allowRoundHour = [],
  allowCollisions = [],
  immutability = true,
}) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const warnings = [];
  const inherited = new Set([...base.keys(), ...settled]);
  const baseDirs = migrationDirs(base.keys());
  const newestBase = baseDirs.at(-1);
  const newestSettled = migrationDirs(inherited).at(-1);
  const added = [...head.keys()].filter((n) => !inherited.has(n)).sort();
  const allowedRound = new Set(allowRoundHour);

  // Immutability: a name that reached base has been applied somewhere.
  if (immutability) {
    for (const [name, blob] of base) {
      if (!head.has(name)) {
        findings.push({
          rule: 'immutable',
          dir: name,
          message: `${name} is removed or renamed. A migration on the base branch has been applied somewhere and its directory name is the ledger key: restore it, and resolve any timestamp problem on the NEW migration instead.`,
        });
      } else if (blob !== undefined && head.get(name) !== undefined && head.get(name) !== blob) {
        findings.push({
          rule: 'immutable',
          dir: name,
          message: `${name}: migration.sql changed. Prisma checksums applied migrations, so editing one fails every later deploy. Add a new migration instead.`,
        });
      }
    }
  }

  const newestSettledMs = newestSettled === undefined ? NaN : timestampMs(newestSettled.slice(0, 14));
  const stuck =
    !Number.isNaN(newestSettledMs) && newestSettledMs > nowMs + SKEW_MS
      ? { dir: /** @type {string} */ (newestSettled), aheadMinutes: Math.round((newestSettledMs - nowMs) / 60000) }
      : null;
  if (stuck) {
    warnings.push(
      `Base branch has a future-dated migration: ${stuck.dir} is ${stuck.aheadMinutes} minutes ahead of this commit. Every migration authored until then must be future-dated too just to sort after it, so the future-dated rule is relaxed to exactly that much.`,
    );
  }
  const ceiling = Math.max(nowMs, Number.isNaN(newestSettledMs) ? nowMs : newestSettledMs) + SKEW_MS;

  for (const dir of added) {
    const m = MIGRATION_DIR.exec(dir);
    if (m === null) {
      findings.push({
        rule: 'bad-name',
        dir,
        message: `${dir} does not start with a 14-digit timestamp (\`<YYYYMMDDHHMMSS>_<name>\`).`,
      });
      continue;
    }
    const ts = /** @type {string} */ (m[1]);
    const ms = timestampMs(ts);
    if (Number.isNaN(ms)) {
      findings.push({ rule: 'bad-timestamp', dir, message: `${dir}: ${ts} is not a real YYYYMMDDHHMMSS instant.` });
      continue;
    }

    if (newestBase !== undefined) {
      const newestTs = newestBase.slice(0, 14);
      if (ts === newestTs) {
        findings.push({
          rule: 'out-of-order',
          dir,
          message: `${dir} collides with ${newestBase}, which is already on the base branch. Rename the new directory to a later timestamp.`,
        });
      } else if (ts < newestTs) {
        findings.push({
          rule: 'out-of-order',
          dir,
          message: `${dir} sorts before ${newestBase}, which is already on the base branch. Prisma applies by name order, so it would run after a chain it claims to precede. Rename it to a later timestamp (free while it is unapplied).${stuck ? ' The base migration is itself future-dated, so sit just after it.' : ''}`,
        });
      }
    }

    if (ms > ceiling) {
      findings.push({
        rule: 'future-dated',
        dir,
        message: `${dir} is dated ${Math.round((ms - nowMs) / 60000)} minutes ahead of this commit. A future-dated migration sorts after everything, merges cleanly, then blocks every migration authored before its nominal time. Rename it to a past UTC timestamp that sorts after the newest on base.`,
      });
    }

    if (roundHour && ts.slice(10, 14) === '0000' && !allowedRound.has(dir)) {
      findings.push({
        rule: 'round-hour',
        dir,
        message: `${dir} is on a round hour (${ts}). Concurrent authors all reach for the round hour, which is how two migrations collide or apply in an order nobody intended. Rename the directory (and nothing else) to an off-hour UTC timestamp that still sorts after the newest on base.`,
      });
    }
  }

  // Duplicate timestamps: only groups containing a directory this branch adds.
  // A group that is entirely settled can no longer be renamed, so it is history.
  // `allowCollisions` forgives an exact set of directories, never the timestamp.
  /** @type {Map<string, string[]>} */
  const byTs = new Map();
  for (const dir of migrationDirs(head.keys())) {
    const ts = dir.slice(0, 14);
    byTs.set(ts, [...(byTs.get(ts) ?? []), dir]);
  }
  const addedSet = new Set(added);
  for (const [ts, group] of [...byTs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (group.length < 2 || !group.some((d) => addedSet.has(d))) continue;
    const sorted = [...group].sort();
    const baselined = allowCollisions.some(
      (g) => g.length === sorted.length && [...g].sort().every((d, i) => d === sorted[i]),
    );
    if (baselined) continue;
    findings.push({
      rule: 'duplicate-timestamp',
      dir: group.find((d) => addedSet.has(d)) ?? group[0],
      message: `${ts} is used by ${group.length} migrations: ${group.join(', ')}. Prisma orders by the whole directory name, so a shared timestamp runs in slug order, never the order anyone intended. Rename the one not yet applied.`,
    });
  }

  return { findings, warnings };
}
