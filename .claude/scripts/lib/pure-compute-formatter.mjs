/**
 * Human-Readable Diagnostic Formatter for Pure-Compute Violations
 *
 * Converts a structured `Violation` into a plain-text diagnostic line so
 * Gate 5 / CLI consumers can render an actionable message. The structured
 * record is NOT mutated (AC7.5); the formatter returns a fresh string.
 *
 * Output format (AC7.1):
 *   "<file>:<line> imports '<specifier>' (category: <symbol>). Reachable from
 *    entry point <entry> via path: <pathToEntry>."
 *
 * Special-symbol phrasing:
 *   <dynamic-import>      -> "uses dynamic import('<arg>')"
 *   <resolution-failed>   -> "could not resolve import '<specifier>'"
 *   <parse-error>         -> "parse error in <file>"
 *
 * No ANSI escapes (AC7.6).
 *
 * Spec: sg-e2e-pure-compute-check atomic as-007 (Task T7)
 * Requirements: REQ-F-011
 */

// =============================================================================
// Public API
// =============================================================================

/**
 * Format a single violation as plain-text.
 *
 * @param {Object} violation
 * @param {string} violation.file
 * @param {string} violation.importSpecifier
 * @param {string} violation.symbol
 * @param {string[]} violation.pathToEntry
 * @param {{line?: number, column?: number}} [violation.span] - Optional line info
 * @returns {string}
 */
export function formatViolation(violation) {
  if (!violation) return '';
  const file = violation.file || '<unknown>';
  const specifier = violation.importSpecifier || '';
  const symbol = violation.symbol || '<unknown>';
  const pathToEntry = Array.isArray(violation.pathToEntry) ? violation.pathToEntry : [file];
  const entry = pathToEntry[0] || file;
  const line = (violation.span && violation.span.line) || '';
  const fileLoc = line ? `${file}:${line}` : file;
  const pathChain = pathToEntry.join(' -> ');

  // Special-symbol phrasing.
  if (symbol === '<dynamic-import>') {
    return (
      `${fileLoc} uses dynamic import(${specifier}). ` +
      `Reachable from entry point ${entry} via path: ${pathChain}.`
    );
  }
  if (symbol === '<resolution-failed>') {
    return (
      `${fileLoc} could not resolve import '${specifier}'. ` +
      `Reachable from entry point ${entry} via path: ${pathChain}.`
    );
  }
  if (symbol === '<parse-error>') {
    return (
      `${fileLoc} parse error in ${file}. ` +
      `Reachable from entry point ${entry} via path: ${pathChain}.`
    );
  }

  // Default phrasing.
  return (
    `${fileLoc} imports '${specifier}' (category: ${symbol}). ` +
    `Reachable from entry point ${entry} via path: ${pathChain}.`
  );
}

/**
 * Format an array of violations joined by newlines.
 *
 * @param {Array} violations
 * @returns {string}
 */
export function formatViolations(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return '';
  return violations.map((v) => formatViolation(v)).join('\n');
}
