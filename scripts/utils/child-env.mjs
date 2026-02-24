/**
 * Minimal environment allowlist for child processes (AS-003).
 *
 * Prevents secret leakage by providing only the environment variables
 * each subprocess needs, rather than inheriting the full parent environment.
 */

// AC3.2: Default allowlist of safe variables
const DEFAULT_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'NODE_ENV',
  'LOG_LEVEL',
];

// AC3.3: Pattern-based allowlist for CLAUDE_* and ANTHROPIC_* variables
const PATTERN_ALLOWLIST = [/^CLAUDE_/, /^ANTHROPIC_/];

/**
 * Builds a minimal environment object for child processes.
 *
 * AC3.1: Exported function importable from both apps/ and cdk/
 * AC3.2: Includes default allowlist (PATH, HOME, USER, SHELL, TERM, NODE_ENV, LOG_LEVEL)
 * AC3.3: Includes all CLAUDE_* and ANTHROPIC_* variables
 * AC3.4: Accepts additional keys per-callsite
 * AC3.5: Logs warning when requested additional key is missing from process.env
 *
 * @param {string[]} [additionalKeys] - Extra env var names to include
 * @returns {Record<string, string>} Filtered environment object
 */
export function buildChildEnv(additionalKeys = []) {
  /** @type {Record<string, string>} */
  const env = {};

  // Include default allowlisted keys
  for (const key of DEFAULT_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  // Include pattern-matched keys (CLAUDE_*, ANTHROPIC_*)
  for (const [key, value] of Object.entries(process.env)) {
    if (PATTERN_ALLOWLIST.some((p) => p.test(key)) && value !== undefined) {
      env[key] = value;
    }
  }

  // AC3.4, AC3.5: Include additional keys with missing-key warnings
  for (const key of additionalKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    } else {
      console.warn(
        `[buildChildEnv] Requested env var '${key}' not present in process.env`,
      );
    }
  }

  return env;
}
