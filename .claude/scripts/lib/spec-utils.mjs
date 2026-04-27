/**
 * Shared spec utility functions.
 *
 * Extracted from import-graph-check.mjs and spec-validate.mjs to eliminate
 * duplicate path extraction logic.
 */

/**
 * Extract file paths from spec markdown content (task list and evidence table).
 * Looks for backtick-quoted paths and pipe-delimited table entries.
 *
 * @param {string} content - Spec markdown content
 * @returns {string[]} Array of unique file paths found
 */
export function extractSpecFilePaths(content) {
  const paths = new Set();

  // Match backtick-quoted file paths: `path/to/file.ts`
  const backtickRe = /`([^`]+\.[a-zA-Z]+)`/g;
  let match;
  while ((match = backtickRe.exec(content)) !== null) {
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(match[1])) {
      paths.add(match[1]);
    }
  }

  // Match paths in evidence table rows: | src/file.ts | description |
  const tableRe = /\|\s*([^\s|]+\.[a-zA-Z]+)\s*\|/g;
  while ((match = tableRe.exec(content)) !== null) {
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(match[1])) {
      paths.add(match[1]);
    }
  }

  return [...paths];
}
