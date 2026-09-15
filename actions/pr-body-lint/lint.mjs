#!/usr/bin/env node
/**
 * Lint a PR body for two silent GitHub closing-keyword traps, ported from
 * MuscleBuddy's `scripts/ci/pr-body-lint.ts` (platform#59; MuscleBuddy #4929,
 * #4597).
 *
 * GitHub's closing-keyword parser has no notion of negation. It scans a PR
 * body for `<keyword> #<number>` and acts on it wherever that shape appears —
 * including inside a sentence written specifically to DENY the link. A body
 * that said "Does not close #4885 — the recapture itself is still owed"
 * closed #4885 the instant that PR merged anyway (MuscleBuddy #4929). There
 * is no phrasing that both uses a closing keyword and disclaims it; the only
 * fix is to reword without the keyword ("see #4885").
 *
 * The sibling trap is the opposite failure mode: `Closes #A, #B` closes only
 * #A (MuscleBuddy #4597) — the keyword has to be repeated per issue. Both
 * checks run here because both are silent: one closes an issue that should
 * stay open, the other leaves one open that should have closed.
 *
 * Scoped tight on purpose. False positives here get the check disabled, so:
 *   - the negation must sit within 3 words of the keyword, and the keyword
 *     within 2 words of the `#` (via KEYWORD_TO_REF), so a negation and a
 *     keyword that merely share a long sentence do not match;
 *   - neither gap crosses a `.`, `!`, `?` or newline, so it never reaches
 *     across a sentence boundary;
 *   - a body that never mentions a closing keyword is untouched — plain
 *     issue mentions ("see #123", "builds on #456") are always fine.
 *
 * Dependency-free plain node, no build step and no `node_modules` needed —
 * a composite action installing dependencies to run one script would cost
 * every consumer an install step for a handful of regexes.
 *
 * Reads the PR body from `$PR_BODY`, never as a shell argument or embedded
 * in a `run:` — a PR body is attacker-controlled text (any contributor
 * writes it) and interpolating it into a shell command is the classic
 * script-injection hole `actions/checkout`'s own docs warn about. `env:` is
 * the safe channel; this only ever reads it as a value, never evaluates it.
 */

/** GitHub's closing keywords (https://docs.github.com/.../linking-a-pull-request-to-an-issue). */
const KEYWORD = String.raw`(?:close[sd]?|closing|fix(?:e[sd])?|fixing|resolve[sd]?|resolving)`;

/** Negation words/phrases that disclaim a keyword GitHub does not read as disclaimed. */
const NEGATION = String.raw`(?:not|n't|never|rather than|instead of)`;

/** Up to `max` intervening words, never crossing a sentence boundary. */
function wordGap(max) {
  return String.raw`(?:\s+[^\s.!?]+){0,${max}}\s*`;
}

/**
 * What GitHub actually accepts between a closing keyword and the issue it
 * closes: whitespace, or a colon. Nothing else — the reference has to be
 * ADJACENT to the keyword.
 *
 * This is the whole reason the guard can be trusted. A version that allows
 * up to two intervening words here reads plausibly ("fixes the crash #123")
 * but is not how the parser works: GitHub does not link that, so flagging it
 * reports a closure that will never happen. Keep the adjacency exact rather
 * than generous, or an auto-generated changelog PR body starts tripping it
 * on ordinary prose (MuscleBuddy #4955).
 */
const KEYWORD_TO_REF = String.raw`\s*:?\s*`;

const NEGATED_CLOSE_RE = new RegExp(
  String.raw`\b${NEGATION}\b${wordGap(3)}\b${KEYWORD}\b${KEYWORD_TO_REF}#\d+`,
  'gi',
);

/** `Closes #A, #B` — a keyword followed by a bare comma-separated issue list. */
const COMMA_LIST_RE = new RegExp(String.raw`\b${KEYWORD}\b${KEYWORD_TO_REF}#\d+\s*,\s*#\d+`, 'gi');

/**
 * Lint a PR body for the two closing-keyword traps. Pure — no I/O.
 *
 * @param {string} body
 * @returns {{ rule: 'negated-close' | 'comma-list', match: string, message: string }[]}
 */
function lintPrBody(body) {
  const findings = [];

  for (const m of body.matchAll(NEGATED_CLOSE_RE)) {
    findings.push({
      rule: 'negated-close',
      match: m[0],
      message:
        `"${m[0].trim()}" — GitHub's closing-keyword parser ignores negation and will still ` +
        `close that issue on merge. Reword without the keyword, e.g. "see #N" or ` +
        `"the work for #N is still owed".`,
    });
  }

  for (const m of body.matchAll(COMMA_LIST_RE)) {
    findings.push({
      rule: 'comma-list',
      match: m[0],
      message:
        `"${m[0].trim()}" — a closing keyword only closes the FIRST issue in a comma-separated ` +
        `list; the rest stay open silently. Repeat the keyword per issue instead ` +
        `(e.g. "Closes #A" / "Closes #B" on separate lines).`,
    });
  }

  return findings;
}

const body = process.env['PR_BODY'] ?? '';
const findings = lintPrBody(body);

if (findings.length === 0) {
  console.log('[pr-body-lint] no closing-keyword traps found.');
  process.exit(0);
}

for (const finding of findings) {
  const title =
    finding.rule === 'negated-close' ? 'Negated closing keyword' : 'Closing keyword comma-list';
  console.log(`::error title=${title}::${finding.message}`);
}

console.log(
  `[pr-body-lint] ${findings.length} finding(s). See the annotations above — reword the PR body and re-run.`,
);
process.exit(1);
