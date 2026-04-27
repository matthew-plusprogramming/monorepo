/**
 * Bash Intent Classifier.
 *
 * Pure-Node, stateless classifier invoked by
 * `.claude/scripts/workflow-file-protection.mjs` on every Bash tool call.
 * Replaces substring-scan protected-file detection with structured,
 * argument-position-granular classification.
 *
 * Primary export:
 *   classifyBashCommandIntent(command) -> { intent, targets, reason? }
 *
 * Legacy export (test backward-compat):
 *   classifyBashCommandIntentString(command) -> 'read' | 'write' | 'ambiguous'
 *
 * Semantics:
 *   - intent='read'       -> allow. No protected targets, or only read-verb
 *                            access on protected files.
 *   - intent='write'      -> consult PPID exemption; otherwise BLOCK.
 *   - intent='ambiguous'  -> fail-closed BLOCK with `reason` populated.
 *
 * All fail-closed paths surface a typed `reason`:
 *   parse_failure | ambiguous | bypass_suspected | length_exceeded
 *
 * Ownership direction: PROTECTED_FILENAMES and PROTECTED_FILENAME_PATTERNS
 * live in workflow-file-protection.mjs (single source of truth). This module
 * RE-EXPORTS them; it does NOT redeclare or curate the list (NFR-008).
 *
 * Design invariants:
 *   - Zero external dependencies (NFR-005).
 *   - Linear-time regexes only (NFR-014).
 *   - 64 KB byte-length guard before parse (NFR-009).
 *   - Recursion depth > 2 -> fail-closed (NFR-009).
 *   - Non-ASCII scan BEFORE NFC (SEC-003 load-bearing).
 *   - Command body never executed in classifier process (SEC-008).
 *
 * Current contract: .claude/docs/bash-intent-classifier.md
 */

import { platform } from 'node:os';
import {
  PROTECTED_FILENAMES,
  PROTECTED_FILENAME_PATTERNS,
} from '../workflow-file-protection.mjs';

// Re-export the single source of truth so consumers (tests + hook call site)
// can import from either path.
export { PROTECTED_FILENAMES, PROTECTED_FILENAME_PATTERNS };

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Maximum accepted byte length of a Bash command before fail-closed.
 * NFR-009 / AC-NFR9.1.
 */
export const MAX_COMMAND_BYTES = 65536;

/**
 * Maximum accepted nesting depth for command substitution and inline-script
 * bodies. NFR-009 / FR-011 (depth > 1 -> fail-closed).
 */
export const MAX_RECURSION_DEPTH = 2;

/**
 * Extended read-verb allowlist. FR-004 / NFR-007. Single source of truth;
 * callers import this constant rather than redeclaring.
 *
 * Total: 23 verbs (as-006/as-007 delivered 7; this refactor extends by 16).
 *
 * Design note: `git` and similar subcommand-aware verbs are NOT in this flat
 * allowlist. They are handled via the subcommand-aware verb dispatch
 * (resolveVerbIntent) — e.g., `git add` is read (stages to index), `git
 * checkout <file>` is write (overwrites working copy).
 *
 * `awk` is listed but handled specially in resolveVerbIntent — read-mode is
 * allowlisted, `-i inplace` is write (FR-005).
 */
export const READ_VERBS = new Set([
  // Baseline (as-007):
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'rg',
  // Extended (FR-004):
  'jq',
  'awk',
  'wc',
  'file',
  'stat',
  'diff',
  'sort',
  'uniq',
  'cut',
  'tr',
  'comm',
  'md5sum',
  'sha256sum',
  'xxd',
  'od',
  'base64',
  // Additional read-only accessors carried from as-007 prior list:
  'egrep',
  'fgrep',
  'ag',
  'ack',
  'cmp',
  'md5',
  'sha1sum',
  'shasum',
  'view',
  'bat',
  'hexdump',
  'strings',
  'readlink',
  'basename',
  'dirname',
  // v2 relaxations — common read-only listing/test verbs. SELF-RESOLVED(code)
  // per AC-ITEM-4.3 generic env-prefix stripping: after `VAR=value ls session.json`
  // strips the prefix, `ls` must resolve to read or positional scan fails closed.
  'ls',
  'echo',
  'printf',
  'test',
]);

/**
 * Inline-script runner verbs whose `-e` / `-c` / `eval` body must be parsed
 * for write-syscall intent. FR-006 / SEC-007.
 */
export const INLINE_RUNNER_VERBS = new Set([
  'node',
  'python',
  'python3',
  'perl',
  'ruby',
  'deno',
  'bun',
  'sh',
  'bash',
]);

/**
 * Unrecognized inline runners — presence of protected basename in body forces
 * fail-closed (FR-006 second clause).
 */
const UNRECOGNIZED_INLINE_RUNNER_VERBS = new Set([
  'php',
  'lua',
  'R',
  'tcl',
  'awkbin', // reserved placeholder; awk handled specially above
]);

/**
 * STRIP tier: prefix command is stripped; verb resolution proceeds on the
 * next token. FR-014.
 */
export const PREFIX_STRIP_STRIP_TIER = new Set([
  'sudo',
  'nohup',
  'timeout',
  'stdbuf',
  'nice',
  'ionice',
  'time',
  'command',
  'builtin',
]);

/**
 * FAIL-CLOSED tier: prefix command indicates dynamic body that cannot be
 * statically analysed. FR-014 second clause.
 */
export const PREFIX_STRIP_FAIL_CLOSED_TIER = new Set([
  'eval',
  // `env -i` handled via `env` + flag check in prefix-strip loop.
]);

/**
 * AMBIGUOUS tier: prefix indicates uncertain recursion or invocation model.
 * FR-014 third clause.
 */
export const PREFIX_STRIP_AMBIGUOUS_TIER = new Set([
  'xargs',
  'find',
  'coproc',
]);

/**
 * Redirection operators whose presence over a protected target indicates
 * write-intent. FR-008.
 */
export const REDIRECTION_OPERATORS = [
  '>',
  '>>',
  '2>',
  '2>>',
  '&>',
  '&>>',
  '>|',
  '<>',
];

/**
 * Write-tool verbs (non-inline-script). Any of these with a protected target
 * -> write. FR-008 complement (shell builtins that write beyond redirection).
 */
const BASH_WRITE_VERBS = new Set([
  'cp',
  'mv',
  'tee',
  'dd',
  'install',
  'rsync',
  'ln',
  'chmod',
  'chown',
  'rm',
  'unlink',
  'touch',
  'truncate',
  'mkdir',
]);

/**
 * Per-language Write-Syscall Matcher Catalog. Regex literals keyed by
 * language. Inline-script bodies are matched against the appropriate set.
 * SEC-007 / FR-006. Linear-time regexes only (NFR-014).
 *
 * Each entry is a regex that detects a write-intent idiom; extraction of the
 * path argument is handled separately (extractBodyPathArgs).
 */
export const WRITE_SYSCALL_PATTERNS = Object.freeze({
  node: [
    // Match any `<ident>.writeFileSync`, `<ident>.writeFile`, etc. where
    // <ident> is any identifier (captures `fs`, `fsp`, `fs.promises` via
    // earlier chain, or other common aliases). This is conservative by
    // design — read-only bodies that happen to contain strings like
    // "writeFileSync" (e.g., in a log message or variable name without
    // `.` prefix) will not match (word-boundary + literal `.`).
    /\.writeFileSync\b/,
    /\.writeFile\b/,
    /\.appendFileSync\b/,
    /\.appendFile\b/,
    /\.createWriteStream\b/,
    /\.writev\b/,
    /\.writevSync\b/,
    // `fs.write` and `fs.writeSync` — require `fs.` prefix (or an alias)
    // followed by the exact method name. Bare `.write(` would over-match
    // console.write etc.; anchor on fs/fsp context.
    /\b(?:fs|fsp|fsPromises)\.write\b/,
    /\b(?:fs|fsp|fsPromises)\.writeSync\b/,
    /\.open\s*\(\s*[^,)]+,\s*['"][wax]/,
    /\.openSync\s*\(\s*[^,)]+,\s*['"][wax]/,
    /\.truncate\b/,
    /\.truncateSync\b/,
    /\.rename\b/,
    /\.renameSync\b/,
    /\.copyFile\b/,
    /\.copyFileSync\b/,
    /\.unlink\b/,
    /\.unlinkSync\b/,
    /\.rmSync\b/,
    /\b(?:fs|fsp|fsPromises)\.rm\b/,
    // Low-level Node API
    /\bprocess\.binding\s*\(\s*['"]fs['"]\s*\)/,
  ],
  python: [
    // open(path, 'w'|'a'|'x'|...+mode)
    /\bopen\s*\(\s*[^,)]+,\s*['"](?:[^'"]*[wax][^'"]*)['"]/,
    // io.open / codecs.open / pathlib
    /\bio\.open\s*\(\s*[^,)]+,\s*['"](?:[^'"]*[wax][^'"]*)['"]/,
    /\bcodecs\.open\s*\(\s*[^,)]+,\s*['"](?:[^'"]*[wax][^'"]*)['"]/,
    /\bPath\s*\([^)]+\)\.write_text\b/,
    /\bPath\s*\([^)]+\)\.write_bytes\b/,
    /\bPath\s*\([^)]+\)\.open\s*\(\s*['"](?:[^'"]*[wax][^'"]*)['"]/,
    /\bos\.remove\b/,
    /\bos\.unlink\b/,
    /\bos\.rename\b/,
    /\bshutil\.copy\w*\b/,
    /\bshutil\.move\b/,
  ],
  perl: [
    // open(FH, '>path') / open(FH, '>>', $path) / open(FH, "+<",$p)
    /\bopen\s*\([^,)]+,\s*['"](?:>|>>|\+<|\+>)/,
    /\bopen\s+[A-Za-z_][A-Za-z0-9_]*\s*,\s*['"](?:>|>>|\+<|\+>)/,
    // print F 'x' usually accompanies an open write; pattern above catches setup
    /\bsysopen\b.*O_(?:WRONLY|CREAT|TRUNC|APPEND)/,
    /\bunlink\b/,
    /\brename\b\s*\(/,
  ],
  ruby: [
    /\bFile\.write\b/,
    /\bFile\.open\s*\([^,)]+,\s*['"](?:w|a|r\+|w\+|a\+)/,
    /\bFile\.new\s*\([^,)]+,\s*['"](?:w|a|r\+|w\+|a\+)/,
    /\bIO\.write\b/,
    /\bFileUtils\.(?:cp|mv|rm|ln)\b/,
    /\bFile\.delete\b/,
    /\bFile\.unlink\b/,
  ],
  deno: [
    /\bDeno\.writeFile\b/,
    /\bDeno\.writeFileSync\b/,
    /\bDeno\.writeTextFile\b/,
    /\bDeno\.writeTextFileSync\b/,
    /\bDeno\.create\b/,
    /\bDeno\.createSync\b/,
    /\bDeno\.openSync?\s*\(\s*[^,)]+,\s*\{[^}]*(?:write|append|create)\s*:\s*true/,
    /\bDeno\.remove(?:Sync)?\b/,
    /\bDeno\.rename(?:Sync)?\b/,
    /\bDeno\.copyFile(?:Sync)?\b/,
  ],
  bun: [
    /\bBun\.write\b/,
    /\bBun\.file\s*\([^)]+\)\.writer\b/,
    // Bun also supports the Node fs/* API; reuse node patterns at caller level.
  ],
  shell: [
    // sh/bash -c body covering common write shapes
    /\btee\b/,
    /\bcp\b/,
    /\bmv\b/,
    /\brm\b/,
    /\btruncate\b/,
    /\bdd\b/,
    /\binstall\b/,
    /\brsync\b/,
    /\bln\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bsed\b[^|;&]*-i\b/,
    // Any redirection operator
    />/,
  ],
});

/**
 * Dynamic-bypass constructs — presence in an inline-script body forces
 * fail-closed (ambiguous). FR-007 / SEC-007.
 * Applied across ALL languages (some patterns are Node/Python/Perl-specific;
 * simple substring match still fails-closed, which is correct behavior).
 */
const DYNAMIC_BYPASS_PATTERNS = [
  // JavaScript / TypeScript
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bAsyncFunction\b/,
  /\bGeneratorFunction\b/,
  // Indirect AsyncFunction via `async function(){}.constructor`
  /\basync\s+function\s*\([^)]*\)\s*\{[^}]*\}\s*\)?\s*\.constructor\b/,
  // Indirect GeneratorFunction via `function*(){}.constructor`
  /\bfunction\s*\*\s*\([^)]*\)\s*\{[^}]*\}\s*\)?\s*\.constructor\b/,
  /\bFunction\s*\(\s*['"]return\s+this['"]\s*\)/,
  /\bReflect\.(?:apply|construct|get|set)\b/,
  /\bfs\s*\[/, // dynamic fs[...] access (bare fs binding)
  // Dynamic method access via computed key on require('fs') / similar:
  //   require('fs')[<ident-or-expr>](...)
  // where the bracketed expression is not a string literal. This catches
  // `require('fs')[op](...)` with `op` as a variable.
  /require\s*\(\s*['"]fs['"]\s*\)\s*\[\s*[A-Za-z_]/,
  /\[\s*`[^`]*\$\{/, // template-literal method access with interpolation
  // Python
  /\b__import__\s*\(/,
  /\bexec\s*\(/,
  // Perl
  /\beval\s+[{"']/,
  // Shell / general
  /\beval\s+["']/,
];

/**
 * Prefixes for awk write-in-place variants. FR-005.
 */
const AWK_INPLACE_FLAGS = /-(?:i|-in-place|-include=inplace\b|i\s+inplace)/;

// ---------------------------------------------------------------------------
// v2 INV-6: Substitution-in-any-token fail-closed (REQ-INV-6, RD-7)
// ---------------------------------------------------------------------------
//
// The active top-level scan is `anyTokenHasInv6TriggerTopLevel` (below), which
// uses two-tier semantics (Tier A unconditional + Tier B conditional) to
// preserve FR-011 AC-11.3 depth-1 recursion for bare `$(...)` substitution.
//
// An earlier monolithic `INV6_TRIGGERS` / `containsInv6Trigger` /
// `anyTokenHasInv6Trigger` implementation was superseded by the two-tier split
// (hasInv6TierATrigger + hasInv6TierBTrigger) and removed in pass-1 review
// cleanup (TECH-001).

/**
 * Tier-A INV-6 triggers — ALWAYS fail-closed when present, regardless of
 * recursion context. These markers have no legacy depth-1 recursion handling
 * (indirect expansion mutates the environment; arithmetic assignment mutates
 * shell variables — both are outside the substitution-body classify path).
 */
const INV6_TIER_A_TRIGGERS = [
  // Indirect variable expansion: ${!name}, ${!prefix@}, ${!prefix*}
  /\$\{!/,
  // Arithmetic assignment / inc / dec (trigger inside $((...)))
  /\$\(\([^)]*(?:=|\+\+|--)[^)]*\)\)/,
];

/**
 * Tier-B INV-6 triggers — command/process substitution and backtick. Only
 * fail-closed when the trigger appears EMBEDDED inside a flag-looking token
 * (starts with `-`) or as a substring inside a larger word (not as the whole
 * word). Bare-substitution forms like `echo $(cat foo)` still go through the
 * existing FR-011 AC-11.3 recursion path (depth-1 read allowed).
 */
const INV6_TIER_B_TRIGGERS = [/\$\(/, /`/, /<\(/, />\(/];

/** True if any tier-A marker is found anywhere in `s`. */
function hasInv6TierATrigger(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  for (const re of INV6_TIER_A_TRIGGERS) if (re.test(s)) return true;
  return false;
}

/** True if any tier-B marker is found anywhere in `s`. */
function hasInv6TierBTrigger(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  for (const re of INV6_TIER_B_TRIGGERS) if (re.test(s)) return true;
  return false;
}

/**
 * Top-level INV-6 scan with two-tier semantics. See classifyInternal comment
 * for the rationale.
 *
 * @param {Token[]} tokens
 * @returns {boolean} true if any token triggers a fail-closed condition.
 */
function anyTokenHasInv6TriggerTopLevel(tokens) {
  for (const t of tokens) {
    if (t.type === 'word') {
      const raw = t.value || '';
      const unq = t.unquoted || '';
      // Tier A: unconditional fail-closed on ${!  or  $((...=))
      if (hasInv6TierATrigger(raw) || hasInv6TierATrigger(unq)) return true;
      // Tier B: only fail-closed when $(/backtick/<(/>( is EMBEDDED inside
      //   (a) a flag-looking token (starts with `-`), e.g. --porcelain=$(evil)
      //   (b) a quoted token whose body contains the trigger AND whose
      //       body is NOT the whole substitution. Detected by:
      //         body starts with "$(" AND ends with ")" — allowed (bare).
      //         otherwise — embedded → fail-closed.
      if (raw.startsWith('-')) {
        if (hasInv6TierBTrigger(raw) || hasInv6TierBTrigger(unq)) return true;
      } else {
        // Non-flag token: allow bare substitution (the entire unquoted body
        // IS a substitution) to proceed to the depth-1 recursion path.
        // Detect "bare" form: unq is wholly `$(…)` or wholly `` `…` ``.
        const body = unq;
        const bare =
          (body.startsWith('$(') && body.endsWith(')')) ||
          (body.startsWith('`') && body.endsWith('`') && body.length > 1) ||
          (body.startsWith('<(') && body.endsWith(')')) ||
          (body.startsWith('>(') && body.endsWith(')'));
        if (!bare && hasInv6TierBTrigger(body)) return true;
      }
    }
    if (t.type === 'redirect') {
      const tgt = t.redirectTarget || '';
      if (hasInv6TierATrigger(tgt) || hasInv6TierBTrigger(tgt)) return true;
    }
    if (t.type === 'heredoc-body') {
      // Unquoted heredoc bodies could contain expansions — fail-closed on
      // any tier-A or tier-B marker (body is opaque; no recursion applies).
      if (!t.heredocQuoted) {
        const v = t.value || '';
        if (hasInv6TierATrigger(v) || hasInv6TierBTrigger(v)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// v2 §10.6 declarative per-verb flag table + registration API (T-08..T-12)
// REQ-ITEM-3.1..3.8, REQ-INV-7 (deep-structural equality)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FlagTable
 * @property {string[]} writeFlags           flags that force intent=write
 * @property {string[]} [readFlags]          flags that force intent=read (wins over write)
 * @property {RegExp}   [writeFlagPattern]   regex-form write flag (e.g., /^-i[A-Za-z.]*$/)
 * @property {string[]} [writeFlagsConsumingValue]  write flags that consume next token as value
 * @property {string[]} [readFlagsConsumingValue]   read flags that consume next token as value
 * @property {string[]} [targetFromFlagValue]  flags whose VALUE is the target basename source
 * @property {string[]} [targetFromUrlBasename] flags whose URL-valued arg's basename is the target
 * @property {'read'|'write'} default         intent when no write/read flag matches
 */

/**
 * Per-verb flag table. Populated at module load via registerVerb calls below.
 * Lookup is by lowercase verb basename.
 * @type {Map<string, FlagTable>}
 */
const VERB_FLAG_TABLE = new Map();

/**
 * Deep-structural equality for re-registration idempotency (REQ-INV-7).
 * List fields compared as unordered Sets. Scalars compared strict-equal.
 * Regex fields compared via .source + .flags.
 *
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function deepStructuralEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  // Regex fields
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  if (a instanceof RegExp || b instanceof RegExp) return false;
  // Arrays compared as unordered Sets
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const setA = new Set(a);
    const setB = new Set(b);
    if (setA.size !== setB.size) return false;
    for (const v of setA) {
      if (!setB.has(v)) return false;
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;
  // Plain objects compared field-by-field
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    const setKa = new Set(ka);
    for (const k of kb) {
      if (!setKa.has(k)) return false;
    }
    for (const k of ka) {
      if (!deepStructuralEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Register a verb's flag table. Idempotent on deep-structural equality;
 * throws `Error: registerVerb conflict for <verb>` on structural difference.
 *
 * REQ-ITEM-3.5 (data-only), REQ-ITEM-3.6 (regex pattern), REQ-INV-7 (deep-equal).
 *
 * @param {string} verb
 * @param {FlagTable} flagTable
 * @returns {void}
 * @throws {Error}
 */
export function registerVerb(verb, flagTable) {
  if (typeof verb !== 'string' || verb.length === 0) {
    throw new Error('registerVerb: verb must be a non-empty string');
  }
  if (!flagTable || typeof flagTable !== 'object') {
    throw new Error('registerVerb: flagTable must be an object');
  }
  if (!Array.isArray(flagTable.writeFlags)) {
    throw new Error('registerVerb: flagTable.writeFlags must be an array');
  }
  if (flagTable.default !== 'read' && flagTable.default !== 'write') {
    throw new Error("registerVerb: flagTable.default must be 'read' or 'write'");
  }
  const key = verb.toLowerCase();
  // SEC-V2-002: Reserved-name guard. VERB_FLAG_TABLE lookup in resolveVerbIntent
  // (L2467) precedes the BASH_WRITE_VERBS check (L2494) — a first-registration
  // of a reserved write-verb (e.g. `cp` with `default: 'read'`) would shadow
  // write-verb semantics. Reject hostile registrations up front.
  if (BASH_WRITE_VERBS.has(key)) {
    throw new Error(
      `registerVerb: '${verb}' is a reserved write-verb (in BASH_WRITE_VERBS). ` +
        `Reserved verbs cannot be registered with custom flag tables.`,
    );
  }
  const prior = VERB_FLAG_TABLE.get(key);
  if (prior) {
    if (deepStructuralEqual(prior, flagTable)) {
      // Idempotent no-op (REQ-INV-7).
      return;
    }
    throw new Error(`registerVerb conflict for ${verb}`);
  }
  VERB_FLAG_TABLE.set(key, flagTable);
}

/**
 * v2 §10.1 / §10.2 git subcommand declarative maps + registration API.
 * REQ-ITEM-3.9, AC-INV-7.
 *
 * Keys are subcommand names (lowercase). Values are objects of shape:
 *   { intent: 'read' | 'write-to-non-protected', variants: string[] }
 * where `variants: ['*']` is a fallback matcher applied ONLY after literal-
 * variant match fails.
 *
 * @type {Map<string, {intent: string, variants: string[]}[]>}
 */
const GIT_SUBCOMMAND_REGISTRY = new Map();

/**
 * Register a git subcommand entry. Equality is `(name, intent, variants-as-unordered-Set)`
 * tuple-equality. Identical re-registration is idempotent; different
 * registration throws `Error: registerGitSubcommand conflict for <name>`.
 *
 * A single subcommand name MAY be registered multiple times with DIFFERENT
 * intents as long as variant sets do not overlap (e.g., `bisect` with
 * intent=read for `log|view|visualize|help` and intent=write-to-non-protected
 * for `start|good|bad|...`).
 *
 * @param {string} name
 * @param {'read'|'write-to-non-protected'} intent
 * @param {string[]} variants  variant tokens; `['*']` is fallback wildcard
 * @returns {void}
 * @throws {Error}
 */
export function registerGitSubcommand(name, intent, variants) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('registerGitSubcommand: name must be a non-empty string');
  }
  if (intent !== 'read' && intent !== 'write-to-non-protected') {
    throw new Error(
      "registerGitSubcommand: intent must be 'read' or 'write-to-non-protected'",
    );
  }
  if (!Array.isArray(variants)) {
    throw new Error('registerGitSubcommand: variants must be an array');
  }
  const key = name.toLowerCase();
  const priors = GIT_SUBCOMMAND_REGISTRY.get(key) || [];
  // Look for any prior entry with the same intent — treat that as the
  // re-registration target (tuple equality on name+intent+variants).
  const newVariantSet = new Set(variants);
  for (const p of priors) {
    if (p.intent === intent) {
      const priorSet = new Set(p.variants);
      if (priorSet.size === newVariantSet.size) {
        let matches = true;
        for (const v of newVariantSet) {
          if (!priorSet.has(v)) {
            matches = false;
            break;
          }
        }
        if (matches) {
          // Idempotent no-op.
          return;
        }
      }
      // Same name+intent but different variants -> structural conflict.
      throw new Error(`registerGitSubcommand conflict for ${name}`);
    }
    // Different intent, same name: variants must not overlap (otherwise
    // the classification is ambiguous).
    for (const v of variants) {
      if (p.variants.includes(v)) {
        throw new Error(`registerGitSubcommand conflict for ${name}`);
      }
    }
  }
  priors.push({ intent, variants: variants.slice() });
  GIT_SUBCOMMAND_REGISTRY.set(key, priors);
}

/**
 * Resolve a git subcommand + variant via the registry.
 * Returns the registered intent ('read' | 'write-to-non-protected') or null
 * if no entry matches.
 *
 * Lookup order (REQ-ITEM-1.3, read-first):
 *   1. For each prior entry (insertion order), try literal variant match
 *      against each token in the variant tokens window.
 *   2. If no literal match, check any entry with variants: ['*'] (fallback).
 *   3. If still no match, return null.
 *
 * Important: We iterate ALL entries for the name and return the FIRST literal
 * match. Entries with `variants: ['*']` are deferred to fallback only.
 *
 * @param {string} subName
 * @param {string[]} variantTokens  remaining argv tokens after the subcommand
 * @returns {'read'|'write-to-non-protected'|null}
 */
function resolveGitSubcommandEntry(subName, variantTokens) {
  const entries = GIT_SUBCOMMAND_REGISTRY.get(subName.toLowerCase());
  if (!entries || entries.length === 0) return null;
  // Read-first: sort entries so read entries checked first (REQ-ITEM-1.3).
  const readFirst = [
    ...entries.filter((e) => e.intent === 'read'),
    ...entries.filter((e) => e.intent !== 'read'),
  ];
  // Pass 1: literal variant match.
  for (const entry of readFirst) {
    if (entry.variants.length === 1 && entry.variants[0] === '*') continue;
    for (const v of entry.variants) {
      for (const tk of variantTokens) {
        if (tk === v) return entry.intent;
      }
    }
  }
  // Pass 2: fallback '*' wildcard.
  for (const entry of readFirst) {
    if (entry.variants.length === 1 && entry.variants[0] === '*') {
      return entry.intent;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// v2 §10.3 git global-flag strip (T-05, T-07; REQ-ITEM-2.1..2.4)
// ---------------------------------------------------------------------------

/**
 * Git global-flag strip table. Each entry declares whether the flag consumes
 * the next token as its value (space form) or accepts `=` form inline.
 *
 *   -C <path>              (space only)
 *   --git-dir[=<path>]
 *   --work-tree[=<path>]
 *   -c <key=value>
 *   --no-pager             (no value)
 *   --no-optional-locks    (no value)
 */
const GIT_GLOBAL_FLAGS_CONSUMING_VALUE_SPACE_ONLY = new Set(['-C']);
const GIT_GLOBAL_FLAGS_CONSUMING_VALUE = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '-c',
]);
const GIT_GLOBAL_FLAGS_NO_VALUE = new Set(['--no-pager', '--no-optional-locks']);
const GIT_GLOBAL_FLAGS_ACCEPTS_EQUALS = new Set(['--git-dir', '--work-tree']);

/**
 * Strip git global flags from the start of `argTokens`. Loops until no
 * leading global flag matches (REQ-ITEM-2.4 loop semantics). Handles:
 *   - `-C /path`           (space)
 *   - `--git-dir=.git`     (equals)
 *   - `--git-dir .git`     (space)
 *   - `-c user.name=x`     (-c always space, value is key=value)
 *   - `--no-pager`         (no value)
 *
 * @param {Token[]} argTokens
 * @returns {Token[]} tokens with leading global flags stripped
 */
function stripGitGlobalFlags(argTokens) {
  let i = 0;
  const n = argTokens.length;
  while (i < n) {
    const t = argTokens[i];
    if (t.type !== 'word') break;
    const raw = t.unquoted || t.value;
    // Equals form: --git-dir=<x>, --work-tree=<x>
    const eqIdx = raw.indexOf('=');
    if (raw.startsWith('--') && eqIdx > 2) {
      const flag = raw.slice(0, eqIdx);
      if (GIT_GLOBAL_FLAGS_ACCEPTS_EQUALS.has(flag)) {
        i++;
        continue;
      }
      // Unknown long flag — stop.
      break;
    }
    // Literal match.
    if (GIT_GLOBAL_FLAGS_NO_VALUE.has(raw)) {
      i++;
      continue;
    }
    if (GIT_GLOBAL_FLAGS_CONSUMING_VALUE.has(raw)) {
      // Consume value token (space form). -C requires space form only;
      // --git-dir and --work-tree are also accepted in equals form (handled above).
      const nxt = argTokens[i + 1];
      if (nxt && nxt.type === 'word') {
        i += 2;
        continue;
      }
      // Dangling global flag with no value -> stop (conservative).
      break;
    }
    // Not a global flag — stop.
    break;
  }
  return argTokens.slice(i);
}

// ---------------------------------------------------------------------------
// v2 §10.6a compound short-flag expansion helpers (T-11; REQ-ITEM-3.7)
// ---------------------------------------------------------------------------

/**
 * Expand a compound short-flag token (e.g., `-xvzf`) into individual char flags
 * (`[-x, -v, -z, -f]`). If the token matches the verb's literal pattern (e.g.,
 * `/^-i[A-Za-z.]*$/` for sed), returns null (caller treats as literal).
 *
 * @param {string} token  argv token (e.g., '-xvzf', '-i.bak', '-f')
 * @param {FlagTable} flagTable
 * @returns {string[]|null} expanded chars, or null if literal-match applies
 */
function expandCompoundShortFlag(token, flagTable) {
  // Must start with single dash and have 2+ chars
  if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) return null;
  // Single-char flag: no expansion needed — just wrap.
  if (token.length === 2) return null;
  // Literal-match check: writeFlagPattern (regex form, e.g., /^-i[A-Za-z.]*$/)
  if (flagTable.writeFlagPattern && flagTable.writeFlagPattern.test(token)) {
    return null;
  }
  // Literal-match check: direct presence in declared flag lists (rare for
  // multi-char flags, but covers declared literals like '-cf', '-tf', '-xf').
  const allFlags = [
    ...(flagTable.writeFlags || []),
    ...(flagTable.readFlags || []),
    ...(flagTable.writeFlagsConsumingValue || []),
    ...(flagTable.readFlagsConsumingValue || []),
  ];
  if (allFlags.includes(token)) return null;
  // Compound expand
  const chars = [];
  for (let i = 1; i < token.length; i++) {
    chars.push('-' + token[i]);
  }
  return chars;
}

// ---------------------------------------------------------------------------
// v2 declarative per-verb resolver (T-10, T-11, T-12; REQ-ITEM-3.1..3.8)
// ---------------------------------------------------------------------------

/**
 * URL basename extractor. For `-O URL` (curl) we extract the basename from
 * the URL path component. If path has no slash after scheme, returns the
 * full path. If URL has no scheme (starts with path), returns basename.
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractUrlBasename(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  // Strip query/fragment
  let s = url.replace(/[?#].*$/, '');
  // Match scheme://host/path or path
  const schemeIdx = s.indexOf('://');
  if (schemeIdx >= 0) {
    s = s.slice(schemeIdx + 3);
    // Strip host up to first /
    const hostEnd = s.indexOf('/');
    if (hostEnd < 0) return null;
    s = s.slice(hostEnd + 1);
  }
  // Trailing slash -> no basename
  if (s.endsWith('/') || s.length === 0) return null;
  const idx = s.lastIndexOf('/');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/**
 * Resolve verb intent via the declarative per-verb flag table.
 * Returns a handled result, or {handled: false} if verb is not registered.
 *
 * Flow:
 *   1. Scan argv for read-flag hits (highest priority) -> read.
 *   2. Scan argv for write-flag hits (literal or pattern) -> write.
 *   3. Compound short-flag expansion on unmatched tokens.
 *   4. If no hits, apply default intent.
 *   5. Target extraction from flag value / URL basename / positional (AC-ITEM-3.8).
 *
 * @param {string} verb
 * @param {Token[]} argTokens
 * @returns {{intent: Intent, targets: ClassifiedTarget[], reason?: FailReason, handled: boolean, _needsTargetScan?: boolean}}
 */
function resolveDeclarativeVerb(verb, argTokens) {
  const table = VERB_FLAG_TABLE.get(verb);
  if (!table) return { intent: 'read', targets: [], handled: false };

  const writeFlags = new Set(table.writeFlags || []);
  const readFlags = new Set(table.readFlags || []);
  const writeConsume = new Set(table.writeFlagsConsumingValue || []);
  const readConsume = new Set(table.readFlagsConsumingValue || []);
  const targetFromFlagValue = new Set(table.targetFromFlagValue || []);
  const targetFromUrlBasename = new Set(table.targetFromUrlBasename || []);

  let hasWriteFlag = false;
  let hasReadFlag = false;
  let unknownCompoundChar = false;
  /** @type {{basename:string, matchType:MatchType, source:TargetSource}[]} */
  const targets = [];

  // Word tokens only (drop redirects — handled elsewhere).
  const words = argTokens.filter((t) => t.type === 'word');

  // First pass: literal flag match + compound expansion.
  // We iterate tokens sequentially to handle value-consuming flags.
  for (let i = 0; i < words.length; i++) {
    const t = words[i];
    const raw = t.unquoted || t.value;
    if (!raw || !raw.startsWith('-')) continue;

    // Read-flag literal match (wins even over write flags).
    if (readFlags.has(raw)) {
      hasReadFlag = true;
      if (readConsume.has(raw)) i++; // skip value
      continue;
    }
    // Write-flag literal match.
    if (writeFlags.has(raw)) {
      hasWriteFlag = true;
      // Target from flag value (e.g., sort -o FILE, tar -cf FILE).
      if (targetFromFlagValue.has(raw)) {
        const nxt = words[i + 1];
        if (nxt) {
          const val = nxt.unquoted || nxt.value;
          const np = normalizePath(val);
          if (np.failClosed) {
            return {
              intent: 'ambiguous',
              targets: [],
              reason: np.reason || 'ambiguous',
              handled: true,
            };
          }
          const prot = matchProtectedBasename(np.basename);
          if (prot) {
            targets.push({
              basename: prot.basename,
              matchType: prot.matchType,
              source: 'positional',
            });
          }
        }
      }
      // Target from URL basename (e.g., curl -O URL).
      if (targetFromUrlBasename.has(raw)) {
        const nxt = words[i + 1];
        if (nxt) {
          const val = nxt.unquoted || nxt.value;
          const urlBase = extractUrlBasename(val);
          if (urlBase) {
            const np = normalizePath(urlBase);
            if (!np.failClosed) {
              const prot = matchProtectedBasename(np.basename);
              if (prot) {
                targets.push({
                  basename: prot.basename,
                  matchType: prot.matchType,
                  source: 'positional',
                });
              }
            }
          }
        }
      }
      if (writeConsume.has(raw)) i++; // skip value
      continue;
    }
    // Regex-form write-flag pattern (e.g., sed -i.bak matches /^-i[A-Za-z.]*$/)
    if (table.writeFlagPattern && table.writeFlagPattern.test(raw)) {
      hasWriteFlag = true;
      continue;
    }

    // Compound short-flag expansion (REQ-ITEM-3.7).
    const expanded = expandCompoundShortFlag(raw, table);
    if (expanded) {
      let compoundWrite = false;
      let compoundRead = false;
      let compoundUnknown = false;
      // Declared "modifiers" for tar — non-classifying (RD-6 footnote).
      // -f is the archive-file modifier: it consumes the next argv token as
      // the archive path but the write/read disposition is determined by
      // the mode chars (-c/-x/-t) that MUST accompany it. Listed here so
      // compound expansion recognizes `-f` as a known (non-classifying)
      // char and does not trigger unknown-compound-char fail-closed.
      const tarModifiers = verb === 'tar'
        ? new Set(['-j', '-z', '-J', '-a', '-v', '-f'])
        : new Set();
      for (const ch of expanded) {
        if (writeFlags.has(ch)) compoundWrite = true;
        else if (readFlags.has(ch)) compoundRead = true;
        else if (tarModifiers.has(ch)) {
          /* modifier — non-classifying */
        } else if (table.writeFlagPattern && table.writeFlagPattern.test(ch)) {
          compoundWrite = true;
        } else {
          compoundUnknown = true;
        }
      }
      if (compoundUnknown) {
        unknownCompoundChar = true;
      } else if (compoundRead && !compoundWrite) {
        hasReadFlag = true;
      } else if (compoundWrite) {
        hasWriteFlag = true;
      }
      continue;
    }
    // Unknown flag for this verb — do not classify either way; fall through.
  }

  // Read-wins (AC-ITEM-3.4).
  if (hasReadFlag && !hasWriteFlag) {
    // Still scan positionals for read-only context? No, read allows.
    return { intent: 'read', targets: [], handled: true };
  }

  // Unknown compound char -> fail-closed (AC-ITEM-3.7).
  if (unknownCompoundChar) {
    return { intent: 'ambiguous', targets: [], reason: 'ambiguous', handled: true };
  }

  if (hasWriteFlag) {
    // AC-ITEM-3.8(c): Positional scan for protected targets.
    const positionalTargets = scanWriteVerbPositionals(argTokens);
    if (positionalTargets.failReason) {
      return {
        intent: 'ambiguous',
        targets: [],
        reason: positionalTargets.failReason,
        handled: true,
      };
    }
    return {
      intent: 'write',
      targets: dedupeTargets([...targets, ...positionalTargets.targets]),
      handled: true,
      // _writeExplicit: this write came from an EXPLICIT declarative write-flag
      // match (literal or compound-char). The ALL-SEGMENT aggregator keeps this
      // classification as write even when targets=[]. Legacy fallthrough writes
      // (no _writeExplicit marker) downgrade to read when targets=[].
      _writeExplicit: true,
    };
  }

  // Apply default intent (AC-ITEM-3.3).
  if (table.default === 'write') {
    // If default is write, still scan positionals.
    return { intent: 'write', targets: [], handled: true, _needsTargetScan: true };
  }
  return { intent: 'read', targets: [], handled: true };
}

// ---------------------------------------------------------------------------
// v2 declarative registrations (module-load-time) — T-10 + T-13
// ---------------------------------------------------------------------------

// §10.6 per-verb flag table registrations (RD-6). 7 verbs.
registerVerb('sed', {
  writeFlags: ['-i', '--in-place'],
  // `-i.bak`, `-i''`, `-iSUFFIX` — BSD/GNU SUFFIX form via regex.
  writeFlagPattern: /^-i[A-Za-z.]*$/,
  readFlagsConsumingValue: ['-f'],
  default: 'read',
});

registerVerb('awk', {
  writeFlags: ['-i', '--in-place'],
  readFlagsConsumingValue: ['-f'],
  default: 'read',
});

registerVerb('sort', {
  writeFlags: ['-o'],
  writeFlagsConsumingValue: ['-o'],
  targetFromFlagValue: ['-o'],
  default: 'read',
});

registerVerb('curl', {
  writeFlags: ['-o', '-O'],
  writeFlagsConsumingValue: ['-o', '-O'],
  targetFromFlagValue: ['-o'],
  targetFromUrlBasename: ['-O'],
  default: 'read',
});

registerVerb('wget', {
  writeFlags: ['-O'],
  writeFlagsConsumingValue: ['-O'],
  targetFromFlagValue: ['-O'],
  default: 'read',
});

// tar — declare both compound literals (-cf/-xf/…) and standalone mode chars
// (-c/-x/-t) so compound-flag expansion (§10.6a / AC-ITEM-3.7) can classify
// expanded chars. Modifiers -v/-z/-J/-j/-a/-f are handled in the expander's
// `tarModifiers` set (non-classifying — -f alone is an archive-file modifier
// that consumes the next positional, but the write/read disposition comes
// from the mode chars -c/-x/-t).
registerVerb('tar', {
  writeFlags: [
    '-cf', '-xf', '-cvf', '-xvf', '-czf', '-xzf', '-cJf', '-xJf',
    // SELF-RESOLVED(spec): AC-ITEM-3.7 + spec footnote in dispatch prompt
    // state "-xvzf → [-x, -v, -z, -f], -x is write flag (extract), write
    // dominates read." -c (create) and -x (extract) are the write-mode tar
    // chars.
    '-c', '-x',
  ],
  readFlags: ['-tf', '-tvf', '-t'],
  writeFlagsConsumingValue: ['-f', '-cf', '-xf', '-cvf', '-xvf', '-czf', '-xzf', '-cJf', '-xJf'],
  targetFromFlagValue: ['-f', '-cf', '-xf', '-cvf', '-xvf', '-czf', '-xzf', '-cJf', '-xJf'],
  default: 'read',
});

registerVerb('jq', {
  writeFlags: ['-i', '--in-place'],
  default: 'read',
});

// §10.1 + §10.2 + §10.1a + §10.1b git subcommand registrations (RD-1/1a/1b/2).
// Read-only:
registerGitSubcommand('worktree', 'read', ['list', 'prune', 'repair']);
registerGitSubcommand('stash', 'read', ['list', 'show']);
registerGitSubcommand('remote', 'read', ['show', '-v', 'get-url']);
registerGitSubcommand('tag', 'read', ['-l', '--list']);
registerGitSubcommand('config', 'read', ['--get', '-l', '--list']);
registerGitSubcommand('rev-parse', 'read', ['*']);
registerGitSubcommand('describe', 'read', ['*']);
registerGitSubcommand('rev-list', 'read', ['*']);
registerGitSubcommand('reflog', 'read', ['*']);
registerGitSubcommand('fsck', 'read', ['*']);
registerGitSubcommand('clean', 'read', ['-n', '--dry-run']);
// Bisect sub-subcommands (RD-1b):
registerGitSubcommand('bisect', 'read', ['log', 'view', 'visualize', 'help']);
registerGitSubcommand('bisect', 'write-to-non-protected', [
  'start',
  'good',
  'bad',
  'skip',
  'reset',
  'run',
  'old',
  'new',
  'replay',
  'terms',
]);
// Write-to-non-protected:
registerGitSubcommand('worktree', 'write-to-non-protected', ['add', 'remove', 'move']);
registerGitSubcommand('stash', 'write-to-non-protected', ['push', 'pop', 'drop']);
registerGitSubcommand('remote', 'write-to-non-protected', ['add', 'remove']);
registerGitSubcommand('clean', 'write-to-non-protected', ['-i', '*']);
registerGitSubcommand('tag', 'write-to-non-protected', ['*']);
registerGitSubcommand('gc', 'write-to-non-protected', ['*']);

/**
 * Bare-form subcommand defaults table (RD-1a, REQ-ITEM-1.4).
 * Applied when the subcommand appears with NO variant token (bare).
 */
const GIT_BARE_DEFAULTS = new Map([
  ['stash', 'write-to-non-protected'],
  ['tag', 'read'],
  ['config', 'read'],
  ['bisect', 'read'],
]);

// ---------------------------------------------------------------------------
// v2 ITEM-5: -m body aliases + UTF-8 exemption scope (T-16, T-17)
// ---------------------------------------------------------------------------
//
// The `git {commit, tag, notes, stash}` UTF-8 body-exemption scope (AC-ITEM-5.2,
// DEC-05) is enforced inline at the ITEM-5.2 body-scan call site. An earlier
// `MESSAGE_EXEMPT_SUBCOMMANDS` Set was orphaned (zero callers) and removed in
// pass-1 review cleanup (SEC-V2-001).

/**
 * Reason enum for fail-closed telemetry.
 * @typedef {'parse_failure'|'ambiguous'|'bypass_suspected'|'length_exceeded'} FailReason
 * @typedef {'read'|'write'|'ambiguous'} Intent
 * @typedef {'positional'|'redirection'|'inline-script'|'substitution'} TargetSource
 * @typedef {'exact'|'pattern'} MatchType
 * @typedef {{basename: string, matchType: MatchType, source: TargetSource}} ClassifiedTarget
 * @typedef {{intent: Intent, targets: ClassifiedTarget[], reason?: FailReason}} ClassificationResult
 */

// ---------------------------------------------------------------------------
// Platform-adaptive case-normalization policy (SEC-004, PLAT-001)
// ---------------------------------------------------------------------------

/**
 * @returns {'case-insensitive'|'case-sensitive'}
 */
function detectCaseSensitivity() {
  const p = platform();
  if (p === 'darwin') return 'case-insensitive'; // APFS / HFS+ default
  if (p === 'linux') {
    // WSL detection: WSL exposes `linux` from Node but mounts NTFS case-insens.
    // Best-effort: presence of /proc/sys/fs/binfmt_misc/WSLInterop indicates WSL,
    // but we avoid fs probing here (pure module). Linux default is case-sensitive;
    // operators on WSL who hit bypass issues can override via env (future work).
    return 'case-sensitive';
  }
  // Undetermined (win32-native, etc.) -> conservative case-insensitive fallback.
  return 'case-insensitive';
}

const CASE_POLICY = detectCaseSensitivity();

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Token
 * @property {'word'|'redirect'|'chain'|'heredoc-body'|'subst-open'|'subst-close'|'group-open'|'group-close'|'proc-sub-open'|'proc-sub-close'} type
 * @property {string} value               raw token text
 * @property {string} [unquoted]          quote-stripped body for word tokens
 * @property {'single'|'double'|'ansi-c'|'none'} [quoteMode]
 * @property {string} [redirectOp]        when type='redirect', the operator
 * @property {string} [redirectTarget]    when type='redirect', the target token (raw)
 * @property {string} [heredocDelim]      heredoc end delimiter (for body tokens)
 * @property {boolean} [heredocQuoted]    whether delimiter was quoted (-> literal body)
 * @property {boolean} [heredocTabStrip]  <<- variant
 */

// ---------------------------------------------------------------------------
// T-06: Fail-closed guards (used by both tokenizer and classifier)
// ---------------------------------------------------------------------------

/**
 * Raw-byte non-ASCII scan. SEC-003 load-bearing. Runs BEFORE NFC on the
 * quote-stripped path token.
 * @param {string} s
 * @returns {boolean} true iff any byte is > 0x7F
 */
function hasNonAscii(s) {
  return /[^\x00-\x7F]/.test(s);
}

/**
 * Byte length of the command string (UTF-8). Used for the 64 KB guard.
 * @param {string} s
 * @returns {number}
 */
function byteLen(s) {
  return Buffer.byteLength(s, 'utf8');
}

// ---------------------------------------------------------------------------
// T-03: Path normalization (normalizePath)
// ---------------------------------------------------------------------------

/**
 * 8-step strict-order basename normalization (SEC-004). The order is
 * load-bearing — do NOT reorder.
 *
 *   1. Quote stripping
 *   2. ANSI-C escape decoding (only for $'...')
 *   3. Non-ASCII raw-byte scan (before NFC) -> fail-closed on non-ASCII
 *   4. NFC normalization
 *   5. Path-separator normalization
 *   6. Basename extraction
 *   7. Platform-adaptive case normalization
 *   8. Compare against PROTECTED_FILENAMES (exact) + PROTECTED_FILENAME_PATTERNS (regex)
 *
 * Additional fail-closed guards:
 *   - Percent-encoded path (SEC-005)
 *   - Glob in path (SEC-005)
 *
 * Tilde handling: `~` and `~user` are treated as literal (SEC-009); we do
 * NOT expand $HOME. Basename extraction proceeds normally.
 *
 * @param {string} rawPath
 * @returns {{basename: string|null, failClosed: boolean, reason?: FailReason}}
 */
export function normalizePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { basename: null, failClosed: true, reason: 'parse_failure' };
  }

  // Step 1: Quote stripping
  const { body, mode } = stripSurroundingQuotes(rawPath);

  // Step 2: ANSI-C escape decoding (only for $'...')
  let decoded = body;
  if (mode === 'ansi-c') {
    decoded = decodeAnsiC(body);
  }

  // Step 3: Raw-byte non-ASCII scan BEFORE NFC (homoglyph defense)
  if (hasNonAscii(decoded)) {
    return { basename: null, failClosed: true, reason: 'bypass_suspected' };
  }

  // Step 3b: Percent-encoded path -> fail-closed (SEC-005, no decode)
  if (/%[0-9A-Fa-f]{2}/.test(decoded)) {
    return { basename: null, failClosed: true, reason: 'bypass_suspected' };
  }

  // Step 3c: Glob characters -> fail-closed (SEC-005, no expansion at classify time)
  if (/[*?[\]{}]/.test(decoded)) {
    return { basename: null, failClosed: true, reason: 'bypass_suspected' };
  }

  // Step 3d: Command substitution in target -> fail-closed (SEC-006)
  if (/\$\(|`/.test(decoded)) {
    return { basename: null, failClosed: true, reason: 'ambiguous' };
  }

  // Step 3e: Variable reference in target -> fail-closed (variables cannot be
  // statically resolved). EC-2.
  if (/\$\{|\$[A-Za-z_]/.test(decoded)) {
    return { basename: null, failClosed: true, reason: 'ambiguous' };
  }

  // Step 4: NFC normalization (no-op on ASCII, but conformant)
  const nfc = decoded.normalize('NFC');

  // Step 5 + 6: path-separator normalize and basename extraction.
  // Tilde literal handling: do not expand ~/ or ~user/; treat as literal prefix.
  const normalized = nfc.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  let name = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  // Trailing tilde-only? Empty string? Both invalid.
  if (name.length === 0) {
    return { basename: null, failClosed: true, reason: 'parse_failure' };
  }

  // Step 7: Platform-adaptive case normalization (comparison-only; we preserve
  // the observed basename in the result for error-message fidelity).
  // The protected-set comparison is done at the caller (matchProtectedBasename).
  return { basename: name, failClosed: false };
}

/**
 * Strip a single layer of surrounding quotes. Handles single, double, and
 * ANSI-C ($'...').
 * @param {string} s
 * @returns {{body: string, mode: 'single'|'double'|'ansi-c'|'none'}}
 */
function stripSurroundingQuotes(s) {
  if (s.length >= 2) {
    if (s.startsWith("$'") && s.endsWith("'")) {
      return { body: s.slice(2, -1), mode: 'ansi-c' };
    }
    if (s.startsWith("'") && s.endsWith("'")) {
      return { body: s.slice(1, -1), mode: 'single' };
    }
    if (s.startsWith('"') && s.endsWith('"')) {
      return { body: s.slice(1, -1), mode: 'double' };
    }
  }
  return { body: s, mode: 'none' };
}

/**
 * Minimal ANSI-C ($'...') decoder for common escapes. Non-exhaustive; any
 * unrecognized escape is left as literal.
 * @param {string} body
 * @returns {string}
 */
function decodeAnsiC(body) {
  return body.replace(/\\(.)/g, (_, c) => {
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case "'":
        return "'";
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '0':
        return '\0';
      default:
        return c;
    }
  });
}

/**
 * Case-adaptive basename comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function basenameEquals(a, b) {
  if (CASE_POLICY === 'case-insensitive') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Test a basename against the PROTECTED_FILENAMES + PROTECTED_FILENAME_PATTERNS
 * set. Returns matchType or null.
 * @param {string} basename
 * @returns {{basename: string, matchType: MatchType} | null}
 */
function matchProtectedBasename(basename) {
  for (const name of PROTECTED_FILENAMES) {
    if (basenameEquals(basename, name)) {
      // Return the CANONICAL protected name (from PROTECTED_FILENAMES) rather
      // than the case-variant observed in the command. This is the shape
      // tests assert on (PLAT-003). Case-variant matched on darwin:
      // `.claude/context/SESSION.json` -> {basename: 'session.json', ...}.
      return { basename: name, matchType: 'exact' };
    }
  }
  for (const entry of PROTECTED_FILENAME_PATTERNS) {
    // Regex patterns are case-sensitive at source; apply case policy by
    // normalizing both sides before test.
    const test =
      CASE_POLICY === 'case-insensitive'
        ? entry.pattern.test(basename.toLowerCase())
        : entry.pattern.test(basename);
    if (test) {
      // For pattern matches, return the observed basename (preserves the
      // rotated-log index in e.g. `kill-switch.log.5.jsonl`).
      return { basename, matchType: 'pattern' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// T-02: Tokenizer
// ---------------------------------------------------------------------------

/**
 * ParseFailure error thrown by the internal tokenizer path. Carries a
 * typed `reason` consumed by the classifier.
 */
class ParseFailure extends Error {
  constructor(reason) {
    super(`bash-intent-classifier: parse failure (${reason})`);
    this.reason = reason;
  }
}

/**
 * Internal tokenizer — throws ParseFailure on error. Used by the classifier.
 * The public `tokenizeBashCommand` wraps this and returns a flat Token[].
 *
 * @param {string} command
 * @returns {Token[]}
 */
function tokenizeInternal(command) {
  if (typeof command !== 'string') {
    throw new ParseFailure('parse_failure');
  }
  const tokens = [];
  const heredocSkipSpans = []; // sorted ascending: [{start,end}, ...]
  let i = 0;
  const n = command.length;

    while (i < n) {
      // If we've arrived at a pending heredoc body span, jump over it.
      if (heredocSkipSpans.length > 0 && i >= heredocSkipSpans[0].start) {
        i = heredocSkipSpans[0].end;
        heredocSkipSpans.shift();
        continue;
      }
      const c = command[i];

      // Whitespace -> skip
      if (c === ' ' || c === '\t' || c === '\n') {
        i++;
        continue;
      }

      // Comment: # to end of line (only at start-of-token position)
      if (c === '#' && (i === 0 || /\s/.test(command[i - 1]))) {
        while (i < n && command[i] !== '\n') i++;
        continue;
      }

      // Chaining operators
      // Order matters: check multi-char operators first (&&, ||, |&, ;;, ;&, ;;&, &>>)
      if (command.startsWith('&&', i)) {
        tokens.push({ type: 'chain', value: '&&' });
        i += 2;
        continue;
      }
      if (command.startsWith('||', i)) {
        tokens.push({ type: 'chain', value: '||' });
        i += 2;
        continue;
      }
      if (command.startsWith('|&', i)) {
        tokens.push({ type: 'chain', value: '|&' });
        i += 2;
        continue;
      }
      // Heredoc (must check before general `<`)
      if (command.startsWith('<<', i) && !command.startsWith('<<<', i)) {
        const hd = parseHeredoc(command, i);
        if (hd.failClosed) {
          throw new ParseFailure(hd.reason || 'parse_failure');
        }
        tokens.push(hd.token);
        if (hd.skipSpan) {
          heredocSkipSpans.push(hd.skipSpan);
          // Keep array sorted by .start (stable since heredocs are consumed
          // in lexical order).
          heredocSkipSpans.sort((a, b) => a.start - b.start);
        }
        // Continue at hd.nextIndex — parseHeredoc returns an index pointing
        // at the first char AFTER the heredoc operator + delimiter label
        // (i.e., still on the `<<EOF` line), so the outer tokenizer
        // processes any trailing tokens (`> target`, `| pipe`, etc.) on the
        // same line. When i reaches skipSpan.start, we jump to skipSpan.end.
        i = hd.nextIndex;
        continue;
      }
      // Here-string <<< — treat body as literal word
      if (command.startsWith('<<<', i)) {
        i += 3;
        // Next word is the here-string body; push as word
        while (i < n && /\s/.test(command[i])) i++;
        const w = readWord(command, i);
        if (w) {
          tokens.push({ type: 'word', value: w.raw, unquoted: w.unquoted, quoteMode: w.mode });
          i = w.nextIndex;
        }
        continue;
      }
      // FD-duplication syntax: `N>&M`, `N<&M`, `>&M`, `<&M` — these copy one
      // file descriptor to another. No file target, no write-intent concern
      // (the duplicated fd was already open). Consume and skip.
      const fdDup = command.slice(i).match(/^(\d*)(>|<)&(\d+|-)/);
      if (fdDup) {
        i += fdDup[0].length;
        continue;
      }

      // FD-numbered redirection: `N>`, `N>>`, `N<`, `N<>`. Treat same as the
      // un-numbered form for intent purposes.
      const fdRedir = command.slice(i).match(/^(\d+)(>>|>\||<>|>|<)/);
      if (fdRedir) {
        const op = fdRedir[2];
        i += fdRedir[0].length;
        while (i < n && /\s/.test(command[i])) i++;
        const w = readWord(command, i);
        if (!w) {
          throw new ParseFailure('parse_failure');
        }
        tokens.push({
          type: 'redirect',
          value: op + ' ' + w.raw,
          redirectOp: op,
          redirectTarget: w.raw,
          unquoted: w.unquoted,
          quoteMode: w.mode,
        });
        i = w.nextIndex;
        continue;
      }

      // Process substitution: `<(...)` / `>(...)` — these are WORD atoms, not
      // redirections. Leave for readWord to consume.
      if ((command[i] === '<' || command[i] === '>') && command[i + 1] === '(') {
        // Fall through to readWord below.
      } else {
      // Redirection operators. Order: &>>, &>, >>, >|, <>, >, <
      let consumedRedirect = false;
      for (const op of ['&>>', '&>', '>>', '>|', '<>', '>', '<']) {
        if (command.startsWith(op, i)) {
          i += op.length;
          // Skip whitespace
          while (i < n && /\s/.test(command[i])) i++;
          // Read target word
          const w = readWord(command, i);
          if (!w) {
            throw new ParseFailure('parse_failure');
          }
          tokens.push({
            type: 'redirect',
            value: op + ' ' + w.raw,
            redirectOp: op,
            redirectTarget: w.raw,
            unquoted: w.unquoted,
            quoteMode: w.mode,
          });
          i = w.nextIndex;
          consumedRedirect = true;
          break;
        }
      }
      if (consumedRedirect) continue;
      } // end of else { redirect-op block } for process-sub fall-through
      if (i >= n) break;
      const c2 = command[i];
      if (c2 === ' ' || c2 === '\t' || c2 === '\n') continue;

      if (c2 === ';') {
        tokens.push({ type: 'chain', value: ';' });
        i++;
        continue;
      }
      if (c2 === '|') {
        tokens.push({ type: 'chain', value: '|' });
        i++;
        continue;
      }
      if (c2 === '&') {
        tokens.push({ type: 'chain', value: '&' });
        i++;
        continue;
      }

      // Brace group { ... } / subshell ( ... )
      if (c2 === '(') {
        tokens.push({ type: 'group-open', value: '(' });
        i++;
        continue;
      }
      if (c2 === ')') {
        tokens.push({ type: 'group-close', value: ')' });
        i++;
        continue;
      }
      if (c2 === '{' && (i + 1 < n && /\s/.test(command[i + 1]))) {
        tokens.push({ type: 'group-open', value: '{' });
        i++;
        continue;
      }
      if (c2 === '}') {
        tokens.push({ type: 'group-close', value: '}' });
        i++;
        continue;
      }
      // Bare `}` mid-line (without the `{ ` form) — treat as group-close.
      // Other chars fall through to readWord.

      // Read a word token (handles quotes and embedded $())
      const w = readWord(command, i);
      if (!w) {
        throw new ParseFailure('parse_failure');
      }
      tokens.push({ type: 'word', value: w.raw, unquoted: w.unquoted, quoteMode: w.mode });
      i = w.nextIndex;
    }

  // Post-tokenize integrity check: unbalanced group-open / group-close count
  // indicates malformed input (e.g., `{ echo x ;`). Fail-closed per NFR-003.
  let groupDepth = 0;
  for (const t of tokens) {
    if (t.type === 'group-open') groupDepth++;
    else if (t.type === 'group-close') groupDepth--;
    if (groupDepth < 0) throw new ParseFailure('parse_failure');
  }
  if (groupDepth !== 0) throw new ParseFailure('parse_failure');

  return tokens;
}

/**
 * Public tokenizer — returns a flat Token[] for well-formed commands.
 * Returns a single-element "parse-failure" token (type: 'parse-error') on
 * malformed input so consumers can still inspect the return as an array
 * without a try/catch. Downstream classifier wraps `tokenizeInternal`
 * directly for structured error handling.
 *
 * @param {string} command
 * @returns {Token[]}
 */
export function tokenizeBashCommand(command) {
  try {
    return tokenizeInternal(command);
  } catch (err) {
    if (err instanceof ParseFailure) {
      return [{
        type: 'parse-error',
        value: '',
        reason: err.reason,
      }];
    }
    throw err;
  }
}

/**
 * Read a single word token starting at index i. Handles single quotes, double
 * quotes, ANSI-C quotes, and escaped spaces. Stops at unquoted whitespace or
 * shell metacharacter.
 *
 * @param {string} s
 * @param {number} i
 * @returns {{raw: string, unquoted: string, mode: 'single'|'double'|'ansi-c'|'none', nextIndex: number} | null}
 */
function readWord(s, i) {
  const n = s.length;
  if (i >= n) return null;
  let raw = '';
  let unquoted = '';
  let mode = 'none';
  let started = false;
  // Track whether this word saw any quoted region (for awk-body-detection,
  // command-substitution-in-redirect-target, etc.).
  let firstQuoteMode = 'none';
  const markQuote = (q) => { if (firstQuoteMode === 'none') firstQuoteMode = q; };

  while (i < n) {
    const c = s[i];

    // Process substitution: <(...) or >(...) — treat as a word atom.
    if (mode === 'none' && (c === '<' || c === '>') && s[i + 1] === '(') {
      // Consume <( or >( then balanced to matching )
      const prefix = s.substring(i, i + 2);
      let depth = 1;
      let j = i + 2;
      let body = '';
      while (j < n && depth > 0) {
        if (s.startsWith('$(', j) || s.startsWith('<(', j) || s.startsWith('>(', j)) {
          depth++;
          body += s.substring(j, j + 2);
          j += 2;
          continue;
        }
        if (s[j] === '(') {
          depth++;
          body += s[j];
          j++;
          continue;
        }
        if (s[j] === ')') {
          depth--;
          if (depth === 0) break;
          body += s[j];
          j++;
          continue;
        }
        body += s[j];
        j++;
      }
      if (depth !== 0) return null;
      const atom = prefix + body + ')';
      raw += atom;
      unquoted += atom;
      i = j + 1;
      started = true;
      continue;
    }

    // Arithmetic substitution: $((...)) — no file access possible; consume
    // and skip. FR-011 fourth clause.
    if (mode === 'none' && c === '$' && s[i + 1] === '(' && s[i + 2] === '(') {
      // Find matching `))`
      let depth = 2;
      let j = i + 3;
      while (j < n && depth > 0) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') depth--;
        j++;
      }
      if (depth !== 0) return null;
      // Emit the arithmetic substitution as an opaque word atom.
      const atom = s.substring(i, j);
      raw += atom;
      unquoted += atom;
      i = j;
      started = true;
      continue;
    }

    // Command substitution: $(...) — treat as a word atom.
    if (mode === 'none' && c === '$' && s[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      let body = '';
      while (j < n && depth > 0) {
        if (s.startsWith('$(', j)) {
          depth++;
          body += '$(';
          j += 2;
          continue;
        }
        if (s[j] === '(') {
          depth++;
          body += s[j];
          j++;
          continue;
        }
        if (s[j] === ')') {
          depth--;
          if (depth === 0) break;
          body += s[j];
          j++;
          continue;
        }
        body += s[j];
        j++;
      }
      if (depth !== 0) return null;
      const atom = '$(' + body + ')';
      raw += atom;
      unquoted += atom;
      i = j + 1;
      started = true;
      continue;
    }

    // Backtick command substitution: `...` — treat as a word atom.
    if (mode === 'none' && c === '`') {
      let j = i + 1;
      let body = '';
      while (j < n && s[j] !== '`') {
        if (s[j] === '\\' && j + 1 < n) {
          body += s.substring(j, j + 2);
          j += 2;
          continue;
        }
        body += s[j];
        j++;
      }
      if (j >= n) return null;
      const atom = '`' + body + '`';
      raw += atom;
      unquoted += atom;
      i = j + 1;
      started = true;
      continue;
    }

    // Stop at unquoted metacharacters
    if (mode === 'none' && (
      c === ' ' || c === '\t' || c === '\n' ||
      c === ';' || c === '|' || c === '&' ||
      c === '(' || c === ')' || c === '<' || c === '>'
    )) {
      if (started) break;
      return null; // can't start on metachar
    }

    // ANSI-C quote $'...'
    if (mode === 'none' && c === '$' && s[i + 1] === "'") {
      mode = 'ansi-c';
      markQuote('ansi-c');
      raw += "$'";
      i += 2;
      started = true;
      let body = '';
      while (i < n) {
        const cc = s[i];
        if (cc === '\\' && i + 1 < n) {
          body += s.substring(i, i + 2);
          i += 2;
          continue;
        }
        if (cc === "'") {
          raw += body + "'";
          unquoted += decodeAnsiC(body);
          i++;
          mode = 'none';
          break;
        }
        body += cc;
        i++;
      }
      continue;
    }

    // Single quote '...'
    if (mode === 'none' && c === "'") {
      mode = 'single';
      markQuote('single');
      raw += "'";
      i++;
      started = true;
      let body = '';
      while (i < n) {
        const cc = s[i];
        if (cc === "'") {
          raw += body + "'";
          unquoted += body;
          i++;
          mode = 'none';
          break;
        }
        body += cc;
        i++;
      }
      if (mode === 'single') {
        // Unterminated
        return null;
      }
      continue;
    }

    // Double quote "..."
    if (mode === 'none' && c === '"') {
      mode = 'double';
      markQuote('double');
      raw += '"';
      i++;
      started = true;
      let body = '';
      while (i < n) {
        const cc = s[i];
        if (cc === '\\' && i + 1 < n) {
          body += s.substring(i, i + 2);
          i += 2;
          continue;
        }
        if (cc === '"') {
          raw += body + '"';
          unquoted += body;
          i++;
          mode = 'none';
          break;
        }
        body += cc;
        i++;
      }
      if (mode === 'double') {
        return null;
      }
      continue;
    }

    // Escaped space or metachar: \<c>
    if (c === '\\' && i + 1 < n) {
      raw += s.substring(i, i + 2);
      unquoted += s[i + 1];
      i += 2;
      started = true;
      continue;
    }

    // Ordinary char
    raw += c;
    unquoted += c;
    i++;
    started = true;
  }

  if (!started) return null;
  return { raw, unquoted, mode: firstQuoteMode, nextIndex: i };
}

/**
 * Parse a heredoc starting at `<<` or `<<-`. Returns a heredoc-body token
 * containing the delimiter + body + whether the delimiter was quoted.
 *
 * Forms: <<EOF, <<'EOF', <<"EOF", <<\EOF, <<-EOF, <<-'EOF', <<-"EOF", <<-\EOF
 *
 * @param {string} s
 * @param {number} i position of the first `<` of `<<`
 * @returns {{token: Token, nextIndex: number, failClosed: boolean, reason?: FailReason}}
 */
function parseHeredoc(s, i) {
  const n = s.length;
  // Skip `<<` or `<<-`
  let idx = i + 2;
  let tabStrip = false;
  if (s[idx] === '-') {
    tabStrip = true;
    idx++;
  }
  // Optional whitespace
  while (idx < n && (s[idx] === ' ' || s[idx] === '\t')) idx++;

  // Read delimiter: can be quoted or unquoted, optional leading backslash
  let delim = '';
  let quoted = false;
  let delimMode = 'none';
  if (s[idx] === "'") {
    quoted = true;
    delimMode = 'single';
    idx++;
    while (idx < n && s[idx] !== "'") {
      delim += s[idx];
      idx++;
    }
    if (s[idx] !== "'") {
      return { token: null, nextIndex: idx, failClosed: true, reason: 'parse_failure' };
    }
    idx++;
  } else if (s[idx] === '"') {
    quoted = true;
    delimMode = 'double';
    idx++;
    while (idx < n && s[idx] !== '"') {
      delim += s[idx];
      idx++;
    }
    if (s[idx] !== '"') {
      return { token: null, nextIndex: idx, failClosed: true, reason: 'parse_failure' };
    }
    idx++;
  } else if (s[idx] === '\\') {
    // <<\EOF — delimiter treated as quoted (no expansion), backslash stripped
    quoted = true;
    delimMode = 'backslash';
    idx++;
    while (idx < n && /[A-Za-z0-9_]/.test(s[idx])) {
      delim += s[idx];
      idx++;
    }
  } else {
    // Unquoted delimiter
    while (idx < n && /[A-Za-z0-9_]/.test(s[idx])) {
      delim += s[idx];
      idx++;
    }
  }

  if (delim.length === 0) {
    return { token: null, nextIndex: idx, failClosed: true, reason: 'parse_failure' };
  }

  // Find the heredoc body bounds so we can:
  //   (a) emit a `heredoc-body` token with the literal body content
  //   (b) tell the outer tokenizer where the body ENDS (pos past the end
  //       delimiter line) so trailing tokens on the heredoc-OPEN line
  //       (e.g., `> target`) are still processed, but the body lines
  //       themselves are skipped over.
  //
  // The outer tokenizer consumes tokens up to and including the newline
  // that ends the `<<EOF` line, then — when it encounters the first
  // character position that falls inside the heredoc body span — jumps
  // straight to the post-body position. We achieve this via a simple
  // trick: return { nextIndex: idx } so the outer loop continues on the
  // same line; additionally return a `skipSpan` tuple {start, end}
  // indicating `[bodyStart, postBody)`. The outer loop checks skipSpan
  // when advancing through whitespace / newline to jump past the body.

  const lineEnd = s.indexOf('\n', idx);
  if (lineEnd < 0) {
    // No newline — empty body, everything consumed.
    return {
      token: {
        type: 'heredoc-body',
        value: '',
        heredocDelim: delim,
        heredocQuoted: quoted,
        heredocTabStrip: tabStrip,
      },
      nextIndex: idx,
      skipSpan: null,
      failClosed: false,
    };
  }
  const bodyStart = lineEnd + 1;

  // Read body until a line that equals delim (or, with tabStrip, tab-prefixed
  // followed by delim)
  const lines = [];
  let pos = bodyStart;
  let foundEnd = false;
  while (pos < n) {
    const nextNl = s.indexOf('\n', pos);
    const line = nextNl >= 0 ? s.slice(pos, nextNl) : s.slice(pos);
    const checkLine = tabStrip ? line.replace(/^\t+/, '') : line;
    if (checkLine === delim) {
      foundEnd = true;
      pos = nextNl >= 0 ? nextNl + 1 : n;
      break;
    }
    lines.push(line);
    if (nextNl < 0) {
      pos = n;
      break;
    }
    pos = nextNl + 1;
  }
  if (!foundEnd) {
    return { token: null, nextIndex: pos, failClosed: true, reason: 'parse_failure' };
  }

  const body = lines.join('\n');
  return {
    token: {
      type: 'heredoc-body',
      value: body,
      heredocDelim: delim,
      heredocQuoted: quoted,
      heredocTabStrip: tabStrip,
    },
    // Continue tokenizing on the same line as `<<EOF` (trailing `> target`).
    nextIndex: idx,
    // When the outer loop reaches `bodyStart`, jump to `postBody`.
    skipSpan: { start: bodyStart, end: pos },
    failClosed: false,
    // Note: we do not parse trailing redirect ops here; the outer tokenizer
    // handles them on the pre-heredoc line because the token sequence is:
    //   [cmd] [redirect >|>> target] [heredoc-body body] [next command...]
    // We push the heredoc-body token AFTER the redirect was already captured
    // by the outer loop. The trailing on the << line (`trailing` above) may
    // contain the redirect target that was already consumed. Because our
    // parseHeredoc is called from the outer tokenizer's `<<` branch BEFORE
    // the redirect-handling branch gets a chance, we need to re-scan
    // `trailing` here. To keep the logic simple, we inject the trailing
    // text back as a synthetic re-scan by returning a `trailing` field.
    // However, the spec's primary concern (FR-012) is:
    //   - heredoc quoted-delimiter -> body literal -> allow if redirect
    //     target is non-protected
    //   - heredoc + protected redirect target -> block
    // These cases are handled at the classifier layer from the redirect
    // token the outer tokenizer produces after scanning `trailing`.
  };
}

// ---------------------------------------------------------------------------
// T-04: Segment splitting + command-substitution depth-1 recursion
// ---------------------------------------------------------------------------

/**
 * Split a token stream into segments on chaining operators (;, &&, ||, |, |&, &).
 * Segment boundaries at group-open / group-close are preserved (nested segments
 * remain flat — the classifier evaluates ALL-SEGMENT regardless).
 *
 * @param {Token[]} tokens
 * @returns {Token[][]} one token array per segment
 */
function splitSegments(tokens) {
  const segments = [];
  let current = [];
  for (const t of tokens) {
    if (t.type === 'chain') {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Within a word, detect `$(...)` and backtick substitution bodies.
 * Returns the list of body strings found (at depth 1 only; depth > 1 triggers
 * fail-closed at the caller).
 *
 * @param {string} s
 * @returns {{bodies: string[], depthExceeded: boolean}}
 */
function extractSubstitutionBodies(s) {
  const bodies = [];
  let depthExceeded = false;
  let i = 0;
  const n = s.length;
  while (i < n) {
    // Arithmetic $((...)) — no command substitution; skip.
    if (s.startsWith('$((', i)) {
      let depth = 2;
      let j = i + 3;
      while (j < n && depth > 0) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') depth--;
        j++;
      }
      if (depth !== 0) return { bodies, depthExceeded: true };
      i = j;
      continue;
    }
    // $(...)
    if (s.startsWith('$(', i)) {
      // Find matching )
      let depth = 1;
      let j = i + 2;
      const start = j;
      while (j < n && depth > 0) {
        if (s.startsWith('$(', j)) {
          depth++;
          // Depth > 1 -> fail-closed
          depthExceeded = true;
          j += 2;
          continue;
        }
        if (s[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (depth !== 0) {
        return { bodies, depthExceeded: true };
      }
      const body = s.slice(start, j);
      bodies.push(body);
      i = j + 1;
      continue;
    }
    // Backtick substitution `...`
    if (s[i] === '`') {
      const j = s.indexOf('`', i + 1);
      if (j < 0) return { bodies, depthExceeded: true };
      bodies.push(s.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    i++;
  }
  return { bodies, depthExceeded };
}

// ---------------------------------------------------------------------------
// T-05: Inline-script body parser
// ---------------------------------------------------------------------------

/**
 * Parse an inline-script body for write-syscall intent and dynamic-bypass
 * constructs. Returns {intent, protectedBasenames[]}.
 *
 * FR-006, FR-007, SEC-007.
 *
 * @param {string} verb - node | python | perl | ruby | deno | bun | sh | bash
 * @param {string} flag - -e, -c, eval
 * @param {string} body - the body string (unquoted)
 * @returns {{intent: Intent, targets: ClassifiedTarget[], reason?: FailReason}}
 */
export function parseInlineScriptBody(verb, flag, body) {
  if (typeof body !== 'string' || body.length === 0) {
    return { intent: 'read', targets: [] };
  }

  // sh / bash -c: recursively classify the body as a shell command. This
  // covers the common `sh -c 'echo x > session.json'` and `bash -c 'sed -i
  // session.json'` shapes without duplicating shell-parsing logic.
  const v = verb ? verb.toLowerCase() : '';
  if (v === 'sh' || v === 'bash') {
    // Recursion depth for nested `-c` bodies: we count this as depth 1 (the
    // outer classifyInternal will cap recursion via MAX_RECURSION_DEPTH).
    return classifyInternal(body, 1);
  }

  // Dynamic-bypass check first (applies across languages)
  for (const p of DYNAMIC_BYPASS_PATTERNS) {
    if (p.test(body)) {
      return { intent: 'ambiguous', targets: [], reason: 'ambiguous' };
    }
  }

  // Depth check on substitution inside the body
  const { bodies: subBodies, depthExceeded } = extractSubstitutionBodies(body);
  if (depthExceeded) {
    return { intent: 'ambiguous', targets: [], reason: 'ambiguous' };
  }
  // Recurse into depth-1 substitution bodies (treat as shell context)
  for (const sub of subBodies) {
    const subRes = classifyInternal(sub, 1);
    if (subRes.intent === 'write') return subRes;
    if (subRes.intent === 'ambiguous') return subRes;
  }

  // Pick per-language catalog
  const catalog = selectCatalog(verb);
  if (!catalog) {
    // Unrecognized inline runner — if body mentions any protected basename,
    // fail-closed. FR-006 second clause.
    if (bodyMentionsProtected(body)) {
      return { intent: 'ambiguous', targets: [], reason: 'ambiguous' };
    }
    return { intent: 'read', targets: [] };
  }

  // Check write-syscall patterns
  let hasWriteSyscall = false;
  for (const p of catalog) {
    if (p.test(body)) {
      hasWriteSyscall = true;
      break;
    }
  }

  // Extract path-literal arguments from the body. We look for string literals
  // that look like filesystem paths and test each against the protected set.
  const bodyPaths = extractBodyPathArgs(body);
  const targets = [];
  for (const raw of bodyPaths) {
    const np = normalizePath(raw);
    if (np.failClosed) {
      // Normalization fail-closed only matters if body has a write syscall or
      // references a protected-looking token. Be conservative: fail-closed.
      if (hasWriteSyscall) {
        return { intent: 'ambiguous', targets: [], reason: np.reason || 'ambiguous' };
      }
      continue;
    }
    const m = matchProtectedBasename(np.basename);
    if (m) {
      targets.push({
        basename: m.basename,
        matchType: m.matchType,
        source: 'inline-script',
      });
    }
  }

  if (hasWriteSyscall && targets.length > 0) {
    return { intent: 'write', targets };
  }
  // Write syscall without any protected target found: treat as read (writes
  // to non-protected paths are not our concern).
  if (hasWriteSyscall) {
    return { intent: 'read', targets: [] };
  }
  // No write syscall: read. Even if body mentions protected names in string
  // literals, a read-only body is allowed (this is the over-match fix).
  return { intent: 'read', targets: [] };
}

/**
 * Select the language-appropriate write-syscall catalog for a verb.
 * Returns null for unrecognized inline runners.
 */
function selectCatalog(verb) {
  const v = verb ? verb.toLowerCase() : '';
  if (v === 'node' || v === 'nodejs') return WRITE_SYSCALL_PATTERNS.node;
  if (v === 'python' || v === 'python3' || v === 'python2') return WRITE_SYSCALL_PATTERNS.python;
  if (v === 'perl') return WRITE_SYSCALL_PATTERNS.perl;
  if (v === 'ruby') return WRITE_SYSCALL_PATTERNS.ruby;
  if (v === 'deno') return WRITE_SYSCALL_PATTERNS.deno;
  if (v === 'bun') {
    // Bun supports both Bun.* and Node fs.*; merge.
    return [...WRITE_SYSCALL_PATTERNS.bun, ...WRITE_SYSCALL_PATTERNS.node];
  }
  if (v === 'sh' || v === 'bash') return WRITE_SYSCALL_PATTERNS.shell;
  return null;
}

/**
 * Extract quoted string literals from an inline-script body that look like
 * path arguments (i.e., could appear as a write-syscall target).
 *
 * Linear-time regex only. This is necessarily approximate — we do not fully
 * parse language-level expressions. The classifier only BLOCKS when both a
 * write-syscall pattern AND a protected basename are co-located in the body.
 *
 * @param {string} body
 * @returns {string[]}
 */
function extractBodyPathArgs(body) {
  const paths = [];
  // Match single-quoted, double-quoted, and template-literal (without interp)
  // string tokens. Template-literal with `${...}` is flagged as dynamic-bypass
  // earlier; non-interpolated templates are safe to treat as literals.
  const re = /(?:'([^'\\]{0,512}(?:\\.[^'\\]{0,512}){0,8})')|(?:"([^"\\]{0,512}(?:\\.[^"\\]{0,512}){0,8})")|(?:`([^`$\\]{0,512}(?:\\.[^`$\\]{0,512}){0,8})`)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const lit = m[1] ?? m[2] ?? m[3];
    if (lit && lit.length > 0) paths.push(lit);
  }
  return paths;
}

/**
 * Check whether a body string contains any protected basename as a substring.
 * Used for unrecognized inline runners (fail-closed policy).
 */
function bodyMentionsProtected(body) {
  for (const name of PROTECTED_FILENAMES) {
    if (body.includes(name)) return true;
  }
  // Pattern stems
  for (const entry of PROTECTED_FILENAME_PATTERNS) {
    const stem = stemFromPattern(entry.pattern);
    if (stem && body.includes(stem)) return true;
  }
  return false;
}

/**
 * Extract a literal stem from a protected-filename regex pattern.
 * Example: /^kill-switch\.log(\.\d+)?\.jsonl$/ -> 'kill-switch.log'
 *          /^rate-limit\.state$/              -> 'rate-limit.state'
 */
function stemFromPattern(re) {
  return re.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\./g, '.')
    .replace(/\([^)]*\)\??/g, '')
    .replace(/\\d\+?/g, '')
    .replace(/[*+?]/g, '');
}

// ---------------------------------------------------------------------------
// Verb intent resolution (reads, writes, inline runners, special cases)
// ---------------------------------------------------------------------------

/**
 * Resolve the intent of a prefix-stripped verb + its arg tokens.
 *
 * Handles:
 *   - Subcommand-aware verbs (git)
 *   - awk read-vs-write (FR-005)
 *   - Read-verb allowlist (FR-004)
 *   - Write-verb set (cp, mv, rm, ...)
 *   - Inline runners (node -e, python -c, ...) — delegates to parseInlineScriptBody
 *   - `exec` three-form (FR-015)
 *
 * @param {string} verb - lowercase verb (basename)
 * @param {Token[]} argTokens - word/redirect tokens for this segment (after verb)
 * @returns {{intent: Intent, targets: ClassifiedTarget[], reason?: FailReason, handled: boolean}}
 *   handled=false means caller should fall back to default intent resolution.
 */
function resolveVerbIntent(verb, argTokens) {
  // exec three-form disposition (FR-015)
  if (verb === 'exec') {
    return resolveExecForm(argTokens);
  }

  // git — subcommand-aware
  if (verb === 'git') {
    return resolveGitSubcommand(argTokens);
  }

  // v2: awk body scan (for `print > "path"`) takes precedence over the
  // declarative -i flag handling — resolveAwk handles both. The declarative
  // table covers the -i flag classification; resolveAwk retains body-scan
  // logic for AC-5.3/AC-5.4 (body redirect to protected literal / variable).
  if (verb === 'awk') {
    return resolveAwk(argTokens);
  }

  // v2 ITEM-3: Declarative per-verb flag table (sed, sort, curl, wget, tar, jq).
  // Migrates the old inline sed -i check (was at L1619 pre-v2) into the table.
  // AC-ITEM-3.1..3.8.
  if (VERB_FLAG_TABLE.has(verb)) {
    return resolveDeclarativeVerb(verb, argTokens);
  }

  // Inline runners: node -e, python -c, perl -e, etc.
  if (INLINE_RUNNER_VERBS.has(verb)) {
    return resolveInlineRunner(verb, argTokens);
  }

  // Unrecognized inline runners (php -r, lua -e, R -e) — fail-closed if body
  // mentions a protected name.
  if (UNRECOGNIZED_INLINE_RUNNER_VERBS.has(verb) || verb === 'php') {
    for (const t of argTokens) {
      if (t.type === 'word' && typeof t.unquoted === 'string' && bodyMentionsProtected(t.unquoted)) {
        return { intent: 'ambiguous', targets: [], reason: 'ambiguous', handled: true };
      }
    }
    // Body does not mention protected names -> read
    return { intent: 'read', targets: [], handled: true };
  }

  // Read-verb allowlist
  if (READ_VERBS.has(verb)) {
    return { intent: 'read', targets: [], handled: true };
  }

  // Write-verb set
  if (BASH_WRITE_VERBS.has(verb)) {
    return { intent: 'write', targets: [], handled: true, _needsTargetScan: true };
  }

  return { intent: 'read', targets: [], handled: false };
}

/**
 * Resolve `exec` three-form disposition.
 *   Form 1: `exec > file` / `exec >> file` / `exec 2> file` — write-redirect
 *   Form 2: `exec <cmd> [args]` — strip `exec`, classify remainder
 *   Form 3: bare `exec` — shell no-op, read intent
 */
function resolveExecForm(argTokens) {
  if (argTokens.length === 0) {
    return { intent: 'read', targets: [], handled: true };
  }
  // Form 1: first non-whitespace token is a redirect
  const first = argTokens[0];
  if (first.type === 'redirect') {
    // Write redirect (>, >>, etc.) -> write-intent with target scan.
    const op = first.redirectOp || '';
    if (op === '<') {
      // `exec < file` applies stdin from file to current shell — nominally a
      // read, but when combined with subsequent truncation operations this
      // becomes a write vector (and the old hook pattern /\bexec\s+</ matched
      // unconditionally). Per NG-004 "block conservatively when unsure": if
      // the redirect target is a protected basename, fail-closed so downstream
      // truncation is not possible.
      const raw = first.redirectTarget || '';
      const np = normalizePath(raw);
      if (!np.failClosed && matchProtectedBasename(np.basename)) {
        return {
          intent: 'ambiguous',
          targets: [],
          reason: 'ambiguous',
          handled: true,
        };
      }
      return { intent: 'read', targets: [], handled: true };
    }
    return { intent: 'write', targets: [], handled: true, _needsTargetScan: true };
  }
  // Form 2: first token is a word (command to exec) — strip and re-resolve
  if (first.type === 'word') {
    const next = (first.unquoted || first.value).trim();
    const nextVerb = basenameOf(next);
    return { intent: 'continue', targets: [], handled: false, _stripped: true, _newVerb: nextVerb, _argTokens: argTokens.slice(1) };
  }
  return { intent: 'read', targets: [], handled: true };
}

/**
 * Parent-fallback (pre-v2) git read/write subcommand sets. v2 keeps these
 * intact for backwards-compatibility — they apply when the declarative §10.1
 * / §10.2 maps do not yield a match.
 */
const GIT_LEGACY_READ_SUBCOMMANDS = new Set([
  'add',
  'diff',
  'log',
  'show',
  'status',
  'blame',
  'ls-files',
  'cat-file',
  'grep',
  'branch',
  'fetch',
  'ls-tree',
  'ls-remote',
  'shortlog',
]);
const GIT_LEGACY_WRITE_SUBCOMMANDS = new Set([
  'checkout',
  'reset',
  'rm',
  'apply',
  'commit',
  'push',
  'merge',
  'rebase',
  'mv',
  'restore',
  'revert',
  'cherry-pick',
  'pull',
  'init',
]);

/**
 * Resolve git subcommand intent via declarative v2 pipeline.
 *
 * Pipeline (AC-ITEM-1.3 read-first lookup order, AC-ITEM-2.1 global-flag strip):
 *   1. Strip global flags from the start of argTokens (§10.3 / RD-3).
 *   2. Find first non-flag word -> subcommand name.
 *   3. Attempt declarative §10.1 / §10.2 / §10.1b lookup (read-first).
 *   4. If registry miss AND subcommand is bare (no following variant),
 *      apply §10.1a bare-form default.
 *   5. Fall back to parent (pre-v2) read/write subcommand sets.
 *   6. Unknown subcommand -> conservative ambiguous.
 *
 * AC-ITEM-1.4 footnote: `git bisect start -- <path>` with a protected <path>
 * promotes to write-to-protected (target capture).
 *
 * @param {Token[]} argTokensWithGlobals
 * @returns {{intent: Intent, targets: ClassifiedTarget[], reason?: FailReason, handled: boolean, _needsTargetScan?: boolean}}
 */
function resolveGitSubcommand(argTokensWithGlobals) {
  // v2: strip global flags (REQ-ITEM-2.1..2.4).
  const argTokens = stripGitGlobalFlags(argTokensWithGlobals);

  // Find first non-flag word -> subcommand name.
  let sub = '';
  let subIndex = -1;
  for (let i = 0; i < argTokens.length; i++) {
    const t = argTokens[i];
    if (t.type !== 'word') continue;
    const v = t.unquoted || t.value;
    if (v.startsWith('-')) continue;
    sub = v;
    subIndex = i;
    break;
  }

  // v2: bare `git` (no subcommand) -> read (status-like invocation).
  if (!sub) {
    return { intent: 'read', targets: [], handled: true };
  }

  // Collect variant tokens: subsequent word tokens (both flag and positional)
  // after the subcommand index. Used for variant-lookup and bare-form check.
  const variantTokens = [];
  for (let i = subIndex + 1; i < argTokens.length; i++) {
    const t = argTokens[i];
    if (t.type !== 'word') continue;
    variantTokens.push(t.unquoted || t.value);
  }

  // v2 AC-ITEM-1.4: bisect start -- <path> protected-basename promotion.
  // Detect before generic registry lookup so protected target is captured.
  if (sub === 'bisect') {
    // Variant tokens: find 'start' then trailing positionals after '--'
    let sawStart = false;
    let sawDashDash = false;
    const trailing = [];
    for (const tv of variantTokens) {
      if (!sawStart && tv === 'start') {
        sawStart = true;
        continue;
      }
      if (sawStart && !sawDashDash && tv === '--') {
        sawDashDash = true;
        continue;
      }
      if (sawDashDash) trailing.push(tv);
    }
    if (sawStart && sawDashDash && trailing.length > 0) {
      const promotedTargets = [];
      for (const raw of trailing) {
        const np = normalizePath(raw);
        if (!np.failClosed) {
          const prot = matchProtectedBasename(np.basename);
          if (prot) {
            promotedTargets.push({
              basename: prot.basename,
              matchType: prot.matchType,
              source: 'positional',
            });
          }
        }
      }
      if (promotedTargets.length > 0) {
        return {
          intent: 'write',
          targets: promotedTargets,
          handled: true,
        };
      }
    }
  }

  // v2 AC-ITEM-1.4 bare-form defaults (RD-1a). Applies when the subcommand
  // has no variant tokens (bare form like `git stash`, `git tag`, `git config`).
  //
  // Bare-form defaults MUST be checked BEFORE the wildcard registry fallback
  // (§10.1a takes precedence over §10.2's `['*']` fallback entry) — otherwise
  // `git tag` would match the `tag → write-to-non-protected ['*']` entry via
  // the wildcard pass and never reach the bare-form `tag → read` default.
  if (GIT_BARE_DEFAULTS.has(sub) && variantTokens.length === 0) {
    const bareIntent = GIT_BARE_DEFAULTS.get(sub);
    if (bareIntent === 'read') {
      return { intent: 'read', targets: [], handled: true };
    }
    if (bareIntent === 'write-to-non-protected') {
      return { intent: 'write', targets: [], handled: true };
    }
  }

  // v2 AC-ITEM-1.3: Declarative registry lookup (read-first).
  // AC-ITEM-1.1 / AC-ITEM-1.2.
  const registryIntent = resolveGitSubcommandEntry(sub, variantTokens);
  if (registryIntent === 'read') {
    return { intent: 'read', targets: [], handled: true };
  }
  if (registryIntent === 'write-to-non-protected') {
    // AC-ITEM-1.2 footnote: scan positionals for protected basenames; if any
    // match, promote to full write with target capture.
    const scan = scanWriteVerbPositionals(argTokens.slice(subIndex + 1));
    if (scan.failReason) {
      return { intent: 'ambiguous', targets: [], reason: scan.failReason, handled: true };
    }
    if (scan.targets.length > 0) {
      return { intent: 'write', targets: scan.targets, handled: true };
    }
    // Write-to-non-protected: classify as write with empty targets -> hook allows.
    return { intent: 'write', targets: [], handled: true };
  }

  // Parent legacy fallback (pre-v2 behavior preserved).
  if (GIT_LEGACY_READ_SUBCOMMANDS.has(sub)) {
    return { intent: 'read', targets: [], handled: true };
  }
  if (GIT_LEGACY_WRITE_SUBCOMMANDS.has(sub)) {
    return { intent: 'write', targets: [], handled: true, _needsTargetScan: true };
  }
  // Unknown subcommand -> conservative ambiguous -> fail-closed.
  return { intent: 'ambiguous', targets: [], reason: 'ambiguous', handled: true };
}

/**
 * Resolve `awk` intent. Read-mode by default; `-i inplace` is write (FR-005).
 * Awk body `print > "/path"` detection is also handled here.
 *
 * v2: Declarative table handles the -i literal flag. This resolver retains
 * awk-specific `-i inplace` space-form (GNU awk) + body-scan logic.
 */
function resolveAwk(argTokens) {
  let inPlace = false;
  let bodyText = '';
  for (let i = 0; i < argTokens.length; i++) {
    const t = argTokens[i];
    if (t.type !== 'word') continue;
    const v = t.unquoted || t.value;
    if (v === '-i' && argTokens[i + 1]) {
      const nxt = argTokens[i + 1];
      if (nxt.type === 'word' && (nxt.unquoted || nxt.value) === 'inplace') {
        inPlace = true;
      }
    }
    // v2: also handle bare `-i` flag as write (matches declarative table).
    if (v === '-i') inPlace = true;
    if (v === '--in-place') inPlace = true;
    if (v.startsWith('-i=')) {
      if (v.slice(3) === 'inplace') inPlace = true;
    }
    if (AWK_INPLACE_FLAGS.test(v) && v !== '-i' && !v.startsWith('-i=')) {
      inPlace = true;
    }
    // First non-flag string likely the body
    if (!v.startsWith('-') && t.quoteMode !== 'none' && !bodyText) {
      bodyText = v;
    }
  }
  if (inPlace) {
    return { intent: 'write', targets: [], handled: true, _needsTargetScan: true };
  }
  // Awk body: `print > "/path"` -> write; if path is variable, fail-closed
  if (bodyText) {
    // Body redirect with literal path
    const m = bodyText.match(/print[^;|&}]*>\s*"([^"]+)"/);
    if (m) {
      const np = normalizePath(m[1]);
      if (np.failClosed) {
        return { intent: 'ambiguous', targets: [], reason: np.reason || 'ambiguous', handled: true };
      }
      const prot = matchProtectedBasename(np.basename);
      if (prot) {
        return {
          intent: 'write',
          targets: [{ basename: prot.basename, matchType: prot.matchType, source: 'inline-script' }],
          handled: true,
        };
      }
      return { intent: 'write', targets: [], handled: true };
    }
    // Body redirect with variable -> fail-closed
    if (/print[^;|&}]*>\s*[A-Za-z_\$]/.test(bodyText)) {
      return { intent: 'ambiguous', targets: [], reason: 'ambiguous', handled: true };
    }
  }
  return { intent: 'read', targets: [], handled: true };
}

/**
 * Resolve inline runner (`node -e`, `python -c`, `perl -e`, `ruby -e`,
 * `deno eval`, `bun -e`, `sh -c`, `bash -c`).
 *
 * Finds the body arg (-e, -c, or after `eval`) and delegates to
 * parseInlineScriptBody.
 */
function resolveInlineRunner(verb, argTokens) {
  let bodyText = null;
  let flag = null;

  // Handle bun special: `bun --eval`, `bun -e`, `bun eval`
  for (let i = 0; i < argTokens.length; i++) {
    const t = argTokens[i];
    if (t.type !== 'word') continue;
    const v = t.unquoted || t.value;
    if (v === '-e' || v === '--eval' || v === '-c' || v === '--command' || v === 'eval') {
      flag = v;
      const nxt = argTokens[i + 1];
      if (nxt && nxt.type === 'word') {
        bodyText = nxt.unquoted || nxt.value;
        break;
      }
    }
    // Combined form: -e'body' or -ebody
    if (v.startsWith('-e') && v.length > 2) {
      flag = '-e';
      bodyText = v.slice(2);
      break;
    }
    if (v.startsWith('-c') && v.length > 2) {
      flag = '-c';
      bodyText = v.slice(2);
      break;
    }
  }

  if (bodyText === null) {
    // No inline body — the verb is executing a script file or running
    // something unknown. Inline runners can read-or-write the files named
    // in their positional args (e.g., `perl script.pl session.json` could
    // read or write the target via the script). Per NG-004 "block
    // conservatively when unsure": if any positional arg names a protected
    // basename, fail-closed.
    for (const t of argTokens) {
      if (t.type !== 'word') continue;
      const raw = t.unquoted || t.value;
      if (!raw || raw.startsWith('-')) continue;
      if (!looksLikePath(raw) && !bodyMentionsProtected(raw)) continue;
      const np = normalizePath(raw);
      if (!np.failClosed && matchProtectedBasename(np.basename)) {
        return {
          intent: 'ambiguous',
          targets: [],
          reason: 'ambiguous',
          handled: true,
        };
      }
      if (bodyMentionsProtected(raw)) {
        return {
          intent: 'ambiguous',
          targets: [],
          reason: 'ambiguous',
          handled: true,
        };
      }
    }
    return { intent: 'read', targets: [], handled: true };
  }

  const bodyResult = parseInlineScriptBody(verb, flag || '', bodyText);
  return {
    intent: bodyResult.intent,
    targets: bodyResult.targets,
    reason: bodyResult.reason,
    handled: true,
  };
}

/**
 * Extract the basename of a path-like token (handles /, \, and quote strip).
 */
function basenameOf(s) {
  const unquoted = stripSurroundingQuotes(s).body;
  const normalized = unquoted.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

// ---------------------------------------------------------------------------
// v2 §10.5 tightened env-prefix regex (REQ-ITEM-4.1, AC-ITEM-4.1..4.4)
// Value class `[A-Za-z0-9_.:/\\@+-]*` replaces the old permissive form. Reduces
// control-character injection attack surface while still admitting legitimate
// env values (paths, versions, flags).
// ---------------------------------------------------------------------------

const ENV_PREFIX_TIGHTENED_REGEX =
  /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.:/\\@+-]*$/;

/**
 * v2 §10.5a env-var security denylist (REQ-ITEM-4.5, DEC-03).
 * Each env-var NAME in this list triggers `intent: ambiguous`,
 * `reason: bypass_suspected` when it appears as a leading env-prefix. The
 * denylist check runs AFTER regex validation but BEFORE verb lookup, applied
 * left-to-right against every contiguous leading prefix.
 *
 * Denylist: 26 env-var NAMES (Set membership) + DYLD_* prefix match. 27
 * effective entries. Security scope: arbitrary-code-execution env vars
 * (LD_PRELOAD et al.); excludes TMPDIR/HISTFILE (file redirection, out of
 * scope) and GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* (legitimate scoping).
 *
 * Allowed (explicitly NOT on denylist): GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*.
 */
const ENV_VAR_DENYLIST_NAMES = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'IFS',
  'PATH',
  'PS4',
  'PYTHONPATH',
  'NODE_OPTIONS',
  'RUBYOPT',
  'RUBYLIB',
  'PERL5OPT',
  'PERL5LIB',
  'LESSOPEN',
  'LESSCLOSE',
  'MANPAGER',
  'PAGER',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'SSH_AUTH_SOCK',
  'PROMPT_COMMAND',
  'SHELLOPTS',
  'BASHOPTS',
  'CDPATH',
]);

/**
 * Denylist membership check. Includes DYLD_* prefix match (Apple dynamic
 * linker family — DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH, etc.).
 * @param {string} name
 * @returns {boolean}
 */
function isDenylistedEnvName(name) {
  if (ENV_VAR_DENYLIST_NAMES.has(name)) return true;
  if (name.startsWith('DYLD_')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// T-02 (cont.) + T-04: Prefix-strip + segment verb resolution
// ---------------------------------------------------------------------------

/**
 * Strip prefix tokens (sudo, env ASSIGNMENTS, nohup, etc.) until we find the
 * actual verb. FR-014.
 *
 * v2 additions (AC-ITEM-4.1..4.5):
 *   - Tightened env-prefix regex (§10.5) — value class restricted
 *   - §10.5a denylist check on every contiguous leading env-prefix — LEFT-TO-RIGHT
 *   - Iteration STOPS at first token that does NOT match env-prefix regex (verb)
 *
 * @param {Token[]} tokens
 * @returns {{verbToken: Token|null, verbIndex: number, failClosed: boolean, reason?: FailReason}}
 */
function stripPrefixes(tokens) {
  let i = 0;
  const n = tokens.length;
  while (i < n) {
    const t = tokens[i];
    if (t.type !== 'word') {
      return { verbToken: null, verbIndex: i, failClosed: false };
    }
    const v = t.unquoted || t.value;
    // env-style VAR=value assignment — v2 §10.5 tightened regex + §10.5a denylist
    // (AC-ITEM-4.1..4.5, DEC-04 LEFT-TO-RIGHT iteration).
    if (ENV_PREFIX_TIGHTENED_REGEX.test(v)) {
      const eqIdx = v.indexOf('=');
      const envName = v.slice(0, eqIdx);
      if (isDenylistedEnvName(envName)) {
        // AC-ITEM-4.5: denylist match -> fail-closed with bypass_suspected.
        return {
          verbToken: null,
          verbIndex: i,
          failClosed: true,
          reason: 'bypass_suspected',
        };
      }
      i++;
      continue;
    }
    // Bare `env` (no -i) — strip
    if (v === 'env') {
      // Check next token for -i (FAIL-CLOSED tier)
      const nxt = tokens[i + 1];
      if (nxt && nxt.type === 'word' && (nxt.unquoted || nxt.value) === '-i') {
        return { verbToken: null, verbIndex: i, failClosed: true, reason: 'ambiguous' };
      }
      i++;
      continue;
    }
    const base = basenameOf(v);
    if (PREFIX_STRIP_FAIL_CLOSED_TIER.has(base)) {
      return { verbToken: null, verbIndex: i, failClosed: true, reason: 'ambiguous' };
    }
    if (PREFIX_STRIP_AMBIGUOUS_TIER.has(base)) {
      return { verbToken: null, verbIndex: i, failClosed: true, reason: 'ambiguous' };
    }
    if (PREFIX_STRIP_STRIP_TIER.has(base)) {
      // Some STRIP-tier prefixes consume an argument (timeout N, nice N,
      // stdbuf -oL, ionice -c3). Best-effort: if next token looks like a
      // number or a flag, skip it too.
      if (base === 'timeout' || base === 'nice' || base === 'ionice' || base === 'stdbuf') {
        const nxt = tokens[i + 1];
        if (nxt && nxt.type === 'word') {
          const nv = nxt.unquoted || nxt.value;
          if (/^\d/.test(nv) || nv.startsWith('-')) {
            i += 2;
            continue;
          }
        }
      }
      i++;
      continue;
    }
    // This is the verb.
    return { verbToken: t, verbIndex: i, failClosed: false };
  }
  return { verbToken: null, verbIndex: n, failClosed: false };
}

/**
 * Classify a single segment's tokens.
 *
 * @param {Token[]} segTokens
 * @param {number} depth recursion depth (for $()/backtick bodies)
 * @returns {{intent: Intent, targets: ClassifiedTarget[], reason?: FailReason}}
 */
function classifySegment(segTokens, depth) {
  if (depth > MAX_RECURSION_DEPTH) {
    return { intent: 'ambiguous', targets: [], reason: 'ambiguous' };
  }
  if (segTokens.length === 0) {
    return { intent: 'read', targets: [] };
  }

  // --- 1. Check for redirections (any segment token) ---
  // Any redirect to a protected target is a write, regardless of verb.
  // FR-008 / FR-010.
  const redirectTargets = [];
  for (const t of segTokens) {
    if (t.type !== 'redirect') continue;
    // Read-only redirections (<) are not write-intent
    if (t.redirectOp === '<') continue;
    // Normalize redirect target
    const raw = t.redirectTarget || '';
    // Substitution in redirect target -> fail-closed (SEC-006)
    if (/\$\(|`/.test(raw)) {
      return { intent: 'ambiguous', targets: [], reason: 'ambiguous' };
    }
    const np = normalizePath(raw);
    if (np.failClosed) {
      return { intent: 'ambiguous', targets: [], reason: np.reason || 'ambiguous' };
    }
    const prot = matchProtectedBasename(np.basename);
    if (prot) {
      redirectTargets.push({
        basename: prot.basename,
        matchType: prot.matchType,
        source: 'redirection',
      });
    }
  }
  if (redirectTargets.length > 0) {
    return { intent: 'write', targets: redirectTargets };
  }

  // --- 2. Recurse into embedded substitutions within word tokens ---
  // EC-44/45 / FR-011.
  for (const t of segTokens) {
    if (t.type !== 'word') continue;
    const raw = t.unquoted || '';
    if (raw.includes('$(') || raw.includes('`')) {
      const { bodies, depthExceeded } = extractSubstitutionBodies(raw);
      if (depthExceeded) {
        return { intent: 'ambiguous', targets: [], reason: 'ambiguous' };
      }
      for (const sub of bodies) {
        const subRes = classifyInternal(sub, depth + 1);
        if (subRes.intent !== 'read') {
          return {
            intent: subRes.intent,
            targets: subRes.targets.map(tg => ({ ...tg, source: 'substitution' })),
            reason: subRes.reason,
          };
        }
      }
    }
    // Process substitution bodies <(...) / >(...) embedded in a word
    if (raw.startsWith('<(') || raw.startsWith('>(')) {
      const psBody = raw.slice(2, raw.endsWith(')') ? raw.length - 1 : raw.length);
      const psRes = classifyInternal(psBody, depth + 1);
      if (psRes.intent !== 'read') {
        return {
          intent: psRes.intent,
          targets: psRes.targets.map(tg => ({ ...tg, source: 'substitution' })),
          reason: psRes.reason,
        };
      }
    }
  }

  // --- 3. Prefix-strip + verb resolution ---
  const prefix = stripPrefixes(segTokens);
  if (prefix.failClosed) {
    return { intent: 'ambiguous', targets: [], reason: prefix.reason || 'ambiguous' };
  }
  if (!prefix.verbToken) {
    return { intent: 'read', targets: [] };
  }
  const verbRaw = prefix.verbToken.unquoted || prefix.verbToken.value;
  let verb = basenameOf(verbRaw).toLowerCase();
  let argTokens = segTokens.slice(prefix.verbIndex + 1);

  // Handle exec-strip (form 2): replace-shell -> new verb
  let verbRes = resolveVerbIntent(verb, argTokens);
  if (verbRes._stripped) {
    verb = verbRes._newVerb;
    argTokens = verbRes._argTokens;
    verbRes = resolveVerbIntent(verb, argTokens);
  }

  // Handle return
  if (verbRes.handled) {
    if (verbRes.intent === 'ambiguous') {
      return { intent: 'ambiguous', targets: [], reason: verbRes.reason || 'ambiguous' };
    }
    if (verbRes.intent === 'write') {
      // Scan arg tokens for protected targets as positional args (FR-001)
      if (verbRes._needsTargetScan) {
        const scan = scanWriteVerbPositionals(argTokens);
        if (scan.failReason) {
          return { intent: 'ambiguous', targets: [], reason: scan.failReason };
        }
        return {
          intent: 'write',
          targets: [...verbRes.targets, ...scan.targets],
        };
      }
      return {
        intent: 'write',
        targets: verbRes.targets,
        // Propagate declarative-write marker to the ALL-SEGMENT aggregator
        // so write-with-no-targets from an EXPLICIT declarative write-flag
        // hit (tar -cvf, sort -o, etc.) survives aggregation instead of being
        // downgraded to read (which is the legacy fallthrough contract).
        _writeExplicit: verbRes._writeExplicit === true,
      };
    }
    // read
    return { intent: 'read', targets: verbRes.targets };
  }

  // Fallback: unknown verb. Conservative — if any positional arg is a
  // protected basename, fail-closed. Otherwise, read.
  for (const t of argTokens) {
    if (t.type !== 'word') continue;
    const raw = t.unquoted || t.value;
    if (!looksLikePath(raw)) continue;
    const np = normalizePath(raw);
    if (np.failClosed) continue;
    if (matchProtectedBasename(np.basename)) {
      return { intent: 'ambiguous', targets: [], reason: 'ambiguous' };
    }
  }
  return { intent: 'read', targets: [] };
}

/**
 * Quick test: does a token look like a filesystem path?
 */
function looksLikePath(s) {
  if (!s) return false;
  // Looks like a path if it contains / or starts with . or ~, or matches a
  // protected basename exactly (e.g., bare 'session.json').
  if (s.includes('/')) return true;
  if (s.startsWith('.') || s.startsWith('~')) return true;
  // Bare protected basename
  for (const name of PROTECTED_FILENAMES) {
    if (basenameEquals(s, name)) return true;
  }
  // Bare pattern stem match (e.g., `kill-switch.log.5.jsonl`)
  for (const entry of PROTECTED_FILENAME_PATTERNS) {
    if (entry.pattern.test(s)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal classifier (recursion-aware)
// ---------------------------------------------------------------------------

/**
 * Internal classifier — takes a command string and a depth counter.
 * @param {string} command
 * @param {number} depth
 * @returns {ClassificationResult}
 */
function classifyInternal(command, depth) {
  if (depth > MAX_RECURSION_DEPTH) {
    return { intent: 'ambiguous', targets: [], reason: 'ambiguous' };
  }

  // Empty / whitespace / comment -> read (NFR-012)
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return { intent: 'read', targets: [] };
  }

  // Tokenize
  let tokens;
  try {
    tokens = tokenizeInternal(command);
  } catch (err) {
    if (err instanceof ParseFailure) {
      return { intent: 'ambiguous', targets: [], reason: err.reason || 'parse_failure' };
    }
    return { intent: 'ambiguous', targets: [], reason: 'parse_failure' };
  }

  // AC-INV-6: Substitution-in-any-token fail-closed (REQ-INV-6, RD-7).
  // Scans EVERY word/redirect/heredoc-body token for the RD-7 trigger list.
  //
  // Two-tier handling (DEC-01 / spec §10 precedence rules):
  //   Tier A (unconditional, depth=0 only): triggers that are NEVER handled by
  //     the existing bare-substitution recursion path — `${!...}` indirect
  //     expansion and `$((...=))` / `$((...++))` / `$((...--))` arithmetic
  //     mutation. Any token containing these markers anywhere → fail-closed
  //     with `bypass_suspected`.
  //   Tier B (conditional, depth=0 only): `$(`, backtick, `<(`, `>(` triggers
  //     already have legacy FR-011 AC-11.3 depth-1 recursion handling for the
  //     case where the ENTIRE word is a substitution body (e.g.,
  //     `echo $(cat foo)` → read). But when `$(` appears as an EMBEDDED
  //     SUBSTRING inside a flag-looking token (starts with `-`) — for example
  //     `--porcelain=$(evil)` — INV-6 overrides: fail-closed. This catches
  //     flag-value substitution without breaking AC-11.3 recursion for bare
  //     substitutions.
  //
  // Runs at depth 0 only: recursive calls from substitution bodies already
  // pass a stripped body like `cat foo`, which has no embedding context.
  if (depth === 0 && anyTokenHasInv6TriggerTopLevel(tokens)) {
    return { intent: 'ambiguous', targets: [], reason: 'bypass_suspected' };
  }

  // Heredoc handling: any heredoc-body token is literal content (unless
  // unquoted delimiter with $VAR/$()/backtick referencing redirection target).
  // Per FR-012, the body itself is not a target; the redirect target (already
  // checked in classifySegment) is what matters. We do need to check unquoted
  // heredoc bodies for variable references that the outer command redirects.
  for (const t of tokens) {
    if (t.type !== 'heredoc-body') continue;
    if (!t.heredocQuoted) {
      // Body is not quoted -> expansions apply. If the preceding redirect
      // target contains a variable, we already fail-closed at normalizePath.
      // Additionally, if the body itself contains `$VAR` AND the segment's
      // redirect target also uses `$VAR`, fail-closed (handled implicitly).
      // Conservative: treat unquoted heredoc + variable in body as ambiguous
      // IF the command redirects to a variable-named target.
      if (/\$[A-Za-z_{]/.test(t.value)) {
        // Look for a redirect in tokens with variable target
        const varRedirect = tokens.find(
          tt => tt.type === 'redirect' && tt.redirectTarget &&
                /\$[A-Za-z_{]/.test(tt.redirectTarget)
        );
        if (varRedirect) {
          return { intent: 'ambiguous', targets: [], reason: 'ambiguous' };
        }
      }
    }
  }

  // Split on group-open/close? For simplicity, flatten groups by dropping
  // group markers (segments still split by chains, which is the main
  // ALL-SEGMENT rule).
  const flatTokens = tokens.filter(t => t.type !== 'group-open' && t.type !== 'group-close' && t.type !== 'heredoc-body');

  // ALL-SEGMENT evaluation
  //
  // Fix (pass-4): a segment that resolves to write with NO protected targets
  // but via an EXPLICIT declarative write-flag match must still be reported
  // as write (the hook allows it because no protected basenames are in play —
  // e.g., `tar -cvf new.tar data/` per AC-ITEM-3.2/3.3/3.7). The
  // `_writeExplicit` marker (set by resolveDeclarativeVerb when a write-flag
  // literal or compound-char hit fires) distinguishes this from legacy
  // write-subcommand fallthroughs (e.g., `git commit -m`, `awk body-redirect
  // to non-protected`) where the downstream test contract treats "write with
  // no protected target" as equivalent to read (allow).
  const segments = splitSegments(flatTokens);
  let anyWriteTargets = [];
  let anyWriteExplicitNoTargets = false;
  let anyAmbiguous = null;
  let anyRead = false;
  for (const seg of segments) {
    const res = classifySegment(seg, depth);
    if (res.intent === 'write') {
      if (res.targets.length > 0) {
        anyWriteTargets.push(...res.targets);
      } else if (res._writeExplicit) {
        anyWriteExplicitNoTargets = true;
      } else {
        // Legacy fallthrough: write with no protected targets → treated as
        // read by the hook contract (allow).
        anyRead = true;
      }
    } else if (res.intent === 'ambiguous') {
      anyAmbiguous = res;
    } else if (res.intent === 'read') {
      anyRead = true;
    }
  }

  if (anyWriteTargets.length > 0) {
    return { intent: 'write', targets: dedupeTargets(anyWriteTargets) };
  }
  if (anyAmbiguous) return anyAmbiguous;
  if (anyWriteExplicitNoTargets) return { intent: 'write', targets: [] };
  if (anyRead || segments.length === 0) return { intent: 'read', targets: [] };
  return { intent: 'read', targets: [] };
}

/**
 * Scan tee / write-verb positional args for protected targets + substitution.
 * Returns { targets, failReason? }. If a positional arg contains command
 * substitution, failReason='ambiguous' (SEC-006 analogue for tee-like verbs).
 */
function scanWriteVerbPositionals(argTokens) {
  const targets = [];
  for (const t of argTokens) {
    if (t.type !== 'word') continue;
    const raw = t.unquoted || t.value;
    if (!raw || raw.startsWith('-')) continue;
    // Command substitution in a write-verb positional -> ambiguous.
    if (/\$\(|`/.test(raw)) {
      return { targets: [], failReason: 'ambiguous' };
    }
    if (!looksLikePath(raw)) continue;
    const np = normalizePath(raw);
    if (np.failClosed) {
      return { targets: [], failReason: np.reason || 'ambiguous' };
    }
    const prot = matchProtectedBasename(np.basename);
    if (prot) {
      targets.push({
        basename: prot.basename,
        matchType: prot.matchType,
        source: 'positional',
      });
    }
  }
  return { targets };
}

/**
 * De-duplicate targets by (basename, matchType, source).
 */
function dedupeTargets(targets) {
  const seen = new Set();
  const out = [];
  for (const t of targets) {
    const key = `${t.basename}\x00${t.matchType}\x00${t.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry points (T-01)
// ---------------------------------------------------------------------------

/**
 * Primary classifier. Returns the structured ClassificationResult.
 *
 * Fail-closed guards applied in order:
 *   1. byte-length > 64 KB -> reason=length_exceeded
 *   2. tokenize / parse failure -> reason=parse_failure
 *   3. non-ASCII / percent-encode / glob in path -> reason=bypass_suspected
 *   4. nesting depth > 2 or dynamic-body construct -> reason=ambiguous
 *
 * @param {string} command
 * @returns {ClassificationResult}
 */
export function classifyBashCommandIntent(command) {
  // Length guard first (NFR-009 / AC-NFR9.1)
  if (typeof command !== 'string') {
    return { intent: 'ambiguous', targets: [], reason: 'parse_failure' };
  }
  if (byteLen(command) > MAX_COMMAND_BYTES) {
    return { intent: 'ambiguous', targets: [], reason: 'length_exceeded' };
  }

  // Delegate to recursive classifier
  try {
    return classifyInternal(command, 0);
  } catch {
    return { intent: 'ambiguous', targets: [], reason: 'parse_failure' };
  }
}

/**
 * Legacy string helper — returns only the intent. For backward-compat with
 * existing test callers (as-007). FR-016.
 *
 * @param {string} command
 * @returns {Intent}
 */
export function classifyBashCommandIntentString(command) {
  return classifyBashCommandIntent(command).intent;
}
