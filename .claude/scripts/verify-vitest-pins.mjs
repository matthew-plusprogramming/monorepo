#!/usr/bin/env node

/**
 * Postinstall guard: verify vitest peer-dependency pin discipline.
 *
 * Vitest pin-drift guard.
 * Covers: AC1.4, AC1.5 (graceful skip), AC1.6 (Node floor)
 * Decisions: DEC-CHK-008, DEC-CHK-012
 *
 * Behavior (fail-closed on pin drift):
 *   - Reads project-root package.json
 *   - Enumerates `vitest` + `@vitest/*` entries in dependencies + devDependencies
 *   - Rejects carat (`^`) and tilde (`~`) prefixes on any matched entry
 *   - Rejects version mismatch vs the `vitest` anchor version
 *   - Exits non-zero on any drift with clear stderr naming the offending package
 *
 * Graceful-skip (AC1.5 / DEC-CHK-012):
 *   - If `package.json` contains NO `vitest` AND NO `@vitest/*` entry in
 *     dependencies or devDependencies, the script logs
 *     `INFO: No @vitest packages installed; verification skipped` and exits 0.
 *   - Presence detection is via `package.json` parse, NOT `node_modules` glob
 *     (which would false-match legacy trees).
 *
 * Node floor (AC1.6 / DEC-CHK-012):
 *   - Requires `process.versions.node` to parse as semver with major >= 18.
 *   - When below, emits a clear stderr error naming the minimum + actual.
 *
 * Exit codes:
 *   0 — all pins OK or no vitest packages installed (graceful skip)
 *   1 — pin drift detected (carat/tilde/mismatch)
 *   2 — Node runtime below minimum
 *   3 — package.json missing or unparseable
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const NODE_FLOOR_MAJOR = 18;

/**
 * Parse `process.versions.node` into {major, minor, patch}. Semver-strict:
 * accepts X.Y.Z only; rejects "18" or "18.0". Returns null on parse failure.
 */
function parseNodeSemver(versionStr) {
  if (!versionStr || typeof versionStr !== 'string') return null;
  const m = versionStr.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.]|$)/);
  if (!m) return null;
  return {
    major: Number.parseInt(m[1], 10),
    minor: Number.parseInt(m[2], 10),
    patch: Number.parseInt(m[3], 10),
  };
}

/**
 * Check Node runtime floor. Accepts optional override (for tests).
 * Returns { ok, reason } where reason is set on failure.
 */
function checkNodeFloor(versionOverride) {
  const version = versionOverride ?? process.versions.node;
  const semver = parseNodeSemver(version);
  if (!semver) {
    return {
      ok: false,
      reason: `ERROR: verify-vitest-pins.mjs cannot parse Node version ${JSON.stringify(
        version
      )}; Node >=${NODE_FLOOR_MAJOR} required`,
    };
  }
  if (semver.major < NODE_FLOOR_MAJOR) {
    return {
      ok: false,
      reason: `ERROR: verify-vitest-pins.mjs requires Node >=${NODE_FLOOR_MAJOR}; current runtime is ${version}`,
    };
  }
  return { ok: true };
}

/**
 * Enumerate vitest-family entries in package.json.
 * Returns Map<pkgName, versionSpec> covering `vitest` + every `@vitest/*` key.
 */
function collectVitestEntries(pkg) {
  const result = new Map();
  const sources = [pkg.dependencies || {}, pkg.devDependencies || {}];
  for (const src of sources) {
    for (const [name, spec] of Object.entries(src)) {
      if (name === 'vitest' || name.startsWith('@vitest/')) {
        result.set(name, spec);
      }
    }
  }
  return result;
}

/**
 * Load package.json. The npm `postinstall` hook runs with `process.cwd()` set
 * to the installing package root, so cwd is the authoritative source. We fall
 * back to the repo-root relative path (two levels up from this script) only
 * when cwd has no package.json — useful for direct invocation during
 * development, NOT for npm lifecycle runs.
 *
 * Ordering matters: tests (as-004 AC1.5) exercise the graceful-skip path by
 * running with cwd=tmpdir; if repo-root is checked first, the script would
 * resolve to the real (populated) package.json and miss the skip path.
 */
function loadPackageJson(baseDir) {
  const here = baseDir || __dirname;
  const candidates = [
    join(process.cwd(), 'package.json'),
    join(here, '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, 'utf8');
        return { path: p, pkg: JSON.parse(text) };
      } catch (err) {
        return { error: `Cannot parse ${p}: ${err.message}` };
      }
    }
  }
  return { error: 'package.json not found (tried cwd and repo root)' };
}

function stripPrefix(spec) {
  const m = spec.match(/^([~^]|>=|<=|>|<|=)?\s*(.*)$/);
  return { prefix: m[1] || '', version: m[2].trim() };
}

/**
 * Validate pin discipline. Returns { ok, errors[] }.
 */
function validatePins(entries) {
  const errors = [];
  const anchor = entries.get('vitest');
  if (!anchor) {
    for (const [name, spec] of entries) {
      const { prefix } = stripPrefix(spec);
      if (prefix) {
        errors.push(`${name}: non-exact version ('${spec}') — remove '${prefix}' prefix`);
      }
    }
    return { ok: errors.length === 0, errors };
  }
  const anchorParsed = stripPrefix(anchor);
  if (anchorParsed.prefix) {
    errors.push(
      `vitest: non-exact version ('${anchor}') — remove '${anchorParsed.prefix}' prefix`
    );
  }
  const anchorVersion = anchorParsed.version;
  for (const [name, spec] of entries) {
    if (name === 'vitest') continue;
    const parsed = stripPrefix(spec);
    if (parsed.prefix) {
      errors.push(`${name}: non-exact version ('${spec}') — remove '${parsed.prefix}' prefix`);
      continue;
    }
    if (parsed.version !== anchorVersion) {
      errors.push(
        `${name}: version mismatch ('${spec}') vs vitest anchor ('${anchorVersion}'); pin all @vitest/* packages to the same exact version`
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Main
// =============================================================================

function main() {
  const floor = checkNodeFloor();
  if (!floor.ok) {
    process.stderr.write(floor.reason + '\n');
    process.exit(2);
  }

  const loaded = loadPackageJson();
  if (loaded.error) {
    process.stderr.write(`ERROR: ${loaded.error}\n`);
    process.exit(3);
  }

  const entries = collectVitestEntries(loaded.pkg);
  if (entries.size === 0) {
    process.stdout.write('INFO: No @vitest packages installed; verification skipped\n');
    process.exit(0);
  }

  const result = validatePins(entries);
  if (!result.ok) {
    process.stderr.write('ERROR: vitest pin drift detected. Offending packages:\n');
    for (const msg of result.errors) {
      process.stderr.write(`  - ${msg}\n`);
    }
    process.stderr.write(
      '\nFix: pin every `vitest` and `@vitest/*` entry in package.json to the same exact version (no ^ or ~ prefix).\n' +
        'See .claude/memory-bank/tech.context.md § Test Infrastructure.\n'
    );
    process.exit(1);
  }

  const anchorVer = stripPrefix(
    entries.get('vitest') || [...entries.values()][0]
  ).version;
  process.stdout.write(
    `INFO: vitest pin discipline OK (${entries.size} packages at ${anchorVer})\n`
  );
  process.exit(0);
}

// Export for tests
export {
  parseNodeSemver,
  checkNodeFloor,
  collectVitestEntries,
  validatePins,
  stripPrefix,
  loadPackageJson,
};

// Run only when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
