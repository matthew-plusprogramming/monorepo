/**
 * /unify Preflight Assertion Helper
 *
 * Implements: REQ-003, AC23.3, SC-3
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-023
 * Parent spec section: §Task List Phase G — Task G3
 *
 * Purpose
 * -------
 * Lightweight, ADVISORY preflight checks that surface implementation-readiness
 * signals from within `/unify`. These checks run once per `/unify` dispatch
 * (they are NOT convergence-loop checks; they do NOT block convergence).
 *
 * The three check categories (per Flow 2, step 5):
 *   1. test-coverage vs AC mapping — count ACs vs test-evidence entries
 *   2. test-file placement          — heuristic location check
 *   3. mock-vs-real mismatches      — simple signal on test files mocking
 *                                     production helpers the spec flags real
 *
 * Return contract
 * ---------------
 * runUnifyPreflight() returns a structured result object:
 *   {
 *     status: "pass" | "advisory",   // "advisory" when any finding exists;
 *                                    //  never "fail" — preflight is non-blocking
 *     findings: Finding[],           // one per surfaced signal
 *     checks: {                      // per-category check outcome
 *       coverageVsAcs:       CheckOutcome,
 *       testFilePlacement:   CheckOutcome,
 *       mockVsRealMismatches: CheckOutcome,
 *     },
 *   }
 *
 * Where:
 *   Finding      = { category, severity, message, spec_id?, evidence?, ... }
 *   CheckOutcome = { status: "ok"|"advisory"|"skipped", message, ... }
 *
 * Non-blocking: callers (the `/unify` skill) MUST surface advisories but MUST
 * NOT treat them as convergence failures.
 *
 * Input contract
 * --------------
 * runUnifyPreflight({ specGroupDir, fs?, pathLib? })
 *   - specGroupDir: absolute path to `.claude/specs/groups/<spec-group-id>`
 *   - fs, pathLib (optional): dependency-injection seams for tests
 */

import * as defaultFs from 'node:fs';
import * as defaultPath from 'node:path';

/**
 * Severity ladder for preflight findings.
 * Kept as a named constant set for downstream renderers.
 */
export const PREFLIGHT_SEVERITY = Object.freeze({
  INFO: 'info',
  ADVISORY: 'advisory',
});

/**
 * Preflight check category identifiers.
 * Exported for testing and for UI renderers that group findings by category.
 */
export const PREFLIGHT_CATEGORIES = Object.freeze({
  COVERAGE_VS_ACS: 'coverage_vs_acs',
  TEST_FILE_PLACEMENT: 'test_file_placement',
  MOCK_VS_REAL_MISMATCH: 'mock_vs_real_mismatch',
});

/**
 * Default roots the `/unify` preflight expects test files to live under.
 * Used by the test-file-placement heuristic.
 * @type {readonly string[]}
 */
const EXPECTED_TEST_ROOTS = Object.freeze([
  '__tests__',
  'tests',
  'test',
  'src/__tests__',
  'src/tests',
]);

/**
 * Main entry point. Runs the three preflight categories and returns a
 * structured result.
 *
 * @param {object} opts
 * @param {string} opts.specGroupDir - Absolute path to the spec group directory.
 * @param {typeof defaultFs} [opts.fs] - Filesystem implementation (DI seam).
 * @param {typeof defaultPath} [opts.pathLib] - Path implementation (DI seam).
 * @returns {UnifyPreflightResult}
 */
export function runUnifyPreflight({
  specGroupDir,
  fs = defaultFs,
  pathLib = defaultPath,
} = {}) {
  if (!specGroupDir || typeof specGroupDir !== 'string') {
    return buildSkippedResult('specGroupDir is required');
  }
  if (!fs.existsSync(specGroupDir)) {
    return buildSkippedResult(`specGroupDir does not exist: ${specGroupDir}`);
  }

  const specs = loadSpecSummaries({ specGroupDir, fs, pathLib });

  const coverageVsAcs = checkCoverageVsAcs({ specs });
  const testFilePlacement = checkTestFilePlacement({ specs });
  const mockVsRealMismatches = checkMockVsRealMismatches({ specs });

  const findings = [
    ...coverageVsAcs.findings,
    ...testFilePlacement.findings,
    ...mockVsRealMismatches.findings,
  ];

  return {
    status: findings.length === 0 ? 'pass' : 'advisory',
    findings,
    checks: {
      coverageVsAcs: summarizeOutcome(coverageVsAcs),
      testFilePlacement: summarizeOutcome(testFilePlacement),
      mockVsRealMismatches: summarizeOutcome(mockVsRealMismatches),
    },
    generated_at: new Date().toISOString(),
  };
}

// =============================================================================
// Category 1: test-coverage vs AC count
// =============================================================================

/**
 * Compare AC count against test-evidence-row count per spec summary.
 * Advisory-only: missing test evidence is surfaced as a finding, never as a
 * convergence failure (the unifier's own traceability check remains
 * authoritative for coverage gating).
 */
function checkCoverageVsAcs({ specs }) {
  const findings = [];
  for (const spec of specs) {
    const acCount = spec.acIds.length;
    const testCount = spec.testEvidenceRowCount;
    if (acCount === 0) continue; // no ACs — nothing to check
    if (testCount < acCount) {
      findings.push({
        category: PREFLIGHT_CATEGORIES.COVERAGE_VS_ACS,
        severity: PREFLIGHT_SEVERITY.ADVISORY,
        spec_id: spec.id,
        message:
          `AC count (${acCount}) exceeds test-evidence rows (${testCount}); ` +
          `unify preflight advisory.`,
        evidence: { ac_count: acCount, test_evidence_rows: testCount },
      });
    }
  }
  return {
    status: findings.length === 0 ? 'ok' : 'advisory',
    findings,
    message:
      findings.length === 0
        ? 'All specs have at least as many test-evidence rows as ACs.'
        : `${findings.length} spec(s) have fewer test-evidence rows than ACs.`,
  };
}

// =============================================================================
// Category 2: test-file placement
// =============================================================================

/**
 * Heuristic: test-evidence entries should reference a file path under one of
 * the expected test roots. Advisory-only — a spec may legitimately place a
 * test file outside the defaults (rare); the preflight surfaces the signal
 * and lets the human judge.
 */
function checkTestFilePlacement({ specs }) {
  const findings = [];
  for (const spec of specs) {
    for (const file of spec.testEvidenceFiles) {
      if (!file || typeof file !== 'string') continue;
      if (!isUnderExpectedTestRoot(file)) {
        findings.push({
          category: PREFLIGHT_CATEGORIES.TEST_FILE_PLACEMENT,
          severity: PREFLIGHT_SEVERITY.ADVISORY,
          spec_id: spec.id,
          message:
            `Test file "${file}" is not under a recognized test root ` +
            `(expected one of: ${EXPECTED_TEST_ROOTS.join(', ')}).`,
          evidence: { file, expected_roots: [...EXPECTED_TEST_ROOTS] },
        });
      }
    }
  }
  return {
    status: findings.length === 0 ? 'ok' : 'advisory',
    findings,
    message:
      findings.length === 0
        ? 'All referenced test files live under recognized test roots.'
        : `${findings.length} test-file reference(s) live outside the recognized test roots.`,
  };
}

// =============================================================================
// Category 3: mock-vs-real mismatches
// =============================================================================

/**
 * Heuristic signal: if a spec's Test Strategy or Implementation Evidence
 * references a module by name AND a test file's own evidence path appears to
 * mock that module, surface an advisory. This is intentionally coarse —
 * semantic mock-vs-real reasoning is out-of-scope.
 */
function checkMockVsRealMismatches({ specs }) {
  const findings = [];
  for (const spec of specs) {
    const strategyLower = (spec.testStrategy || '').toLowerCase();
    if (!strategyLower) continue;
    const prohibitsMocks =
      strategyLower.includes('integration') ||
      strategyLower.includes('real') ||
      strategyLower.includes('no mock');
    if (!prohibitsMocks) continue;
    const mockingFiles = spec.testEvidenceFiles.filter((f) =>
      /(^|\/)mocks?(\/|\.)/i.test(f || ''),
    );
    if (mockingFiles.length > 0) {
      findings.push({
        category: PREFLIGHT_CATEGORIES.MOCK_VS_REAL_MISMATCH,
        severity: PREFLIGHT_SEVERITY.ADVISORY,
        spec_id: spec.id,
        message:
          `Test Strategy signals integration/real-service preference, but ` +
          `test-evidence references mock file(s): ${mockingFiles.join(', ')}.`,
        evidence: { mocking_files: mockingFiles, strategy_signal: strategyLower.slice(0, 120) },
      });
    }
  }
  return {
    status: findings.length === 0 ? 'ok' : 'advisory',
    findings,
    message:
      findings.length === 0
        ? 'No mock-vs-real mismatch signals detected.'
        : `${findings.length} spec(s) show a mock-vs-real signal mismatch.`,
  };
}

// =============================================================================
// Spec summary loading (lightweight, markdown-aware)
// =============================================================================

/**
 * Load active `spec.md` plus optional `slices/*.md` summaries. Legacy
 * `atomic/*.md` files are read only as a fallback for old spec groups that do
 * not yet have current-form markdown.
 *
 * @returns {SpecSummary[]}
 */
function loadSpecSummaries({ specGroupDir, fs, pathLib }) {
  const files = [];
  const specPath = pathLib.join(specGroupDir, 'spec.md');
  if (fs.existsSync(specPath)) files.push(specPath);

  const slicesDir = pathLib.join(specGroupDir, 'slices');
  if (fs.existsSync(slicesDir)) {
    try {
      for (const name of fs.readdirSync(slicesDir).filter((n) => n.endsWith('.md'))) {
        files.push(pathLib.join(slicesDir, name));
      }
    } catch {
      // Ignore unreadable optional slices; preflight is advisory.
    }
  }

  if (files.length === 0) {
    const legacyAtomicDir = pathLib.join(specGroupDir, 'atomic');
    if (fs.existsSync(legacyAtomicDir)) {
      try {
        for (const name of fs.readdirSync(legacyAtomicDir).filter((n) => n.endsWith('.md'))) {
          files.push(pathLib.join(legacyAtomicDir, name));
        }
      } catch {
        // Ignore unreadable legacy directories; preflight is advisory.
      }
    }
  }

  const specs = [];
  for (const absPath of files) {
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    specs.push(parseSpecSummary({ content, filename: pathLib.basename(absPath) }));
  }
  return specs;
}

/**
 * Parse a single markdown spec summary and extract the fields the preflight
 * needs.
 *
 * @returns {SpecSummary}
 */
function parseSpecSummary({ content, filename }) {
  const id = extractId({ content, filename });
  const acIds = extractAcIds(content);
  const { testEvidenceRowCount, testEvidenceFiles } =
    extractTestEvidence(content);
  const testStrategy = extractSection(content, 'Test Strategy');
  return {
    id,
    acIds,
    testEvidenceRowCount,
    testEvidenceFiles,
    testStrategy,
  };
}

function extractId({ content, filename }) {
  const m = content.match(/^id:\s*([^\n]+)/m);
  if (m) return m[1].trim();
  return filename.replace(/\.md$/, '');
}

function extractAcIds(content) {
  const ids = new Set();
  const re = /\bAC\d+(?:\.\d+)?\b/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    ids.add(match[0]);
  }
  return [...ids];
}

function extractTestEvidence(content) {
  const section = extractSection(content, 'Test Evidence');
  if (!section) return { testEvidenceRowCount: 0, testEvidenceFiles: [] };
  const lines = section.split(/\r?\n/);
  let rowCount = 0;
  const files = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    // Skip table header and separator rows
    if (/^\|\s*-+/.test(line)) continue;
    if (/^\|\s*(file|spec|ac|test|description)/i.test(line)) continue;
    rowCount += 1;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    for (const cell of cells) {
      if (
        cell &&
        (cell.includes('/') || cell.endsWith('.mjs') || cell.endsWith('.ts') || cell.endsWith('.js'))
      ) {
        files.push(cell.replace(/`/g, ''));
        break; // first file-looking cell per row is enough
      }
    }
  }
  return { testEvidenceRowCount: rowCount, testEvidenceFiles: files };
}

/**
 * Extract the text body of a level-2 section (## <name>) from a markdown
 * document. Returns the empty string if the section is not found.
 *
 * cr-regex-m1:
 *   JavaScript regex has NO `\Z` anchor — `\Z` in a character class or bare
 *   form matches a literal 'Z' character. The prior terminator
 *   `(?=^##\s|\Z)` therefore only terminated at either the next `## ` header
 *   or at a literal 'Z' in the body, causing trailing content after the
 *   target section to be swallowed whenever the section was the document's
 *   last one. The correct JS idiom for "end of input" in a lazy quantifier
 *   is the negative lookahead `$(?![\s\S])` — `$` pins to end-of-line (with
 *   `m` flag) and `(?![\s\S])` asserts no further characters exist, which
 *   only holds at the true end of the string.
 */
function extractSection(content, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`,
    'm',
  );
  const match = content.match(re);
  return match ? match[1].trim() : '';
}

function isUnderExpectedTestRoot(file) {
  return EXPECTED_TEST_ROOTS.some(
    (root) =>
      file === root ||
      file.startsWith(`${root}/`) ||
      file.includes(`/${root}/`),
  );
}

function summarizeOutcome(outcome) {
  return {
    status: outcome.status,
    finding_count: outcome.findings.length,
    message: outcome.message,
  };
}

function buildSkippedResult(reason) {
  return {
    status: 'pass',
    findings: [],
    checks: {
      coverageVsAcs: { status: 'skipped', finding_count: 0, message: reason },
      testFilePlacement: { status: 'skipped', finding_count: 0, message: reason },
      mockVsRealMismatches: { status: 'skipped', finding_count: 0, message: reason },
    },
    generated_at: new Date().toISOString(),
    skipped_reason: reason,
  };
}

/**
 * @typedef {object} SpecSummary
 * @property {string} id
 * @property {string[]} acIds
 * @property {number} testEvidenceRowCount
 * @property {string[]} testEvidenceFiles
 * @property {string} testStrategy
 */

/**
 * @typedef {object} UnifyPreflightFinding
 * @property {string} category
 * @property {string} severity
 * @property {string} message
 * @property {string} [spec_id]
 * @property {object} [evidence]
 */

/**
 * @typedef {object} UnifyPreflightCheckOutcome
 * @property {"ok"|"advisory"|"skipped"} status
 * @property {number} finding_count
 * @property {string} message
 */

/**
 * @typedef {object} UnifyPreflightResult
 * @property {"pass"|"advisory"} status
 * @property {UnifyPreflightFinding[]} findings
 * @property {{
 *   coverageVsAcs: UnifyPreflightCheckOutcome,
 *   testFilePlacement: UnifyPreflightCheckOutcome,
 *   mockVsRealMismatches: UnifyPreflightCheckOutcome,
 * }} checks
 * @property {string} generated_at
 * @property {string} [skipped_reason]
 */
