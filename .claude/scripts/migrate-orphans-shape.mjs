#!/usr/bin/env node

/**
 * One-shot migration: convert `orphans[]` from string[] to object[] provenance form.
 *
 * Reads `.claude/metaclaude-registry.json`, rewrites every string entry in orphans[]
 * to the object form `{path, reason: "legacy", added_by: "migration", added_date: "2026-04-14"}`,
 * and writes back deterministically (alphabetical keys, 2-space indent, trailing newline).
 *
 * On success, the script moves itself to `.claude/scripts/archive/migrate-orphans-shape.mjs.2026-04-14`
 * so it cannot accidentally run again on a mixed-shape registry.
 *
 * Spec: sg-sync-registry-gaps T1.3, T1.4, AC-4.2.
 *
 * Usage:
 *   node .claude/scripts/migrate-orphans-shape.mjs              # Run migration
 *   node .claude/scripts/migrate-orphans-shape.mjs --dry-run    # Show what would change, no write
 *   node .claude/scripts/migrate-orphans-shape.mjs --registry <path>  # Override registry location (tests)
 *   node .claude/scripts/migrate-orphans-shape.mjs --no-archive # Skip self-archive (tests)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inlined from lib/sync-constants.mjs so this one-shot executor is self-contained
// and can be copied to a tmp-dir fixture without pulling the entire lib/.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}
function sortedJsonStringify(value) {
  return JSON.stringify(sortKeysDeep(value), null, 2) + '\n';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REGISTRY_PATH = resolve(__dirname, '..', 'metaclaude-registry.json');
const DEFAULT_ARCHIVE_DIR = resolve(__dirname, 'archive');
const DEFAULT_ARCHIVE_NAME = 'migrate-orphans-shape.mjs.2026-04-14';

// Migration constants per spec T1.4 Outcome.
const LEGACY_REASON = 'legacy';
const LEGACY_ADDED_BY = 'migration';
const LEGACY_ADDED_DATE = '2026-04-14';

function parseArgs(argv) {
  const args = { dryRun: false, noArchive: false, registryPath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-archive') args.noArchive = true;
    else if (arg === '--registry') args.registryPath = argv[++i];
    else if (arg.startsWith('--registry=')) args.registryPath = arg.slice('--registry='.length);
  }
  return args;
}

function migrateOrphansEntry(entry) {
  if (typeof entry === 'string') {
    return {
      path: entry,
      reason: LEGACY_REASON,
      added_by: LEGACY_ADDED_BY,
      added_date: LEGACY_ADDED_DATE,
    };
  }
  // Already in object form -- leave untouched. This preserves idempotency in the
  // pathological case of a mixed-shape registry (should never happen, but safe).
  return entry;
}

export function migrateOrphans(registry) {
  const before = registry.orphans || [];
  const migrated = before.map(migrateOrphansEntry);
  const stringCount = before.filter((e) => typeof e === 'string').length;
  return {
    registry: { ...registry, orphans: migrated },
    migratedCount: stringCount,
    totalCount: before.length,
  };
}

function selfArchive(archiveDir = DEFAULT_ARCHIVE_DIR, archiveName = DEFAULT_ARCHIVE_NAME) {
  mkdirSync(archiveDir, { recursive: true });
  const destPath = join(archiveDir, archiveName);
  renameSync(__filename, destPath);
  return destPath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryPath = args.registryPath
    ? resolve(args.registryPath)
    : DEFAULT_REGISTRY_PATH;

  if (!existsSync(registryPath)) {
    console.error(`Registry not found: ${registryPath}`);
    process.exit(1);
  }

  const raw = readFileSync(registryPath, 'utf-8');
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (err) {
    console.error(`Invalid JSON in ${registryPath}: ${err.message}`);
    process.exit(1);
  }

  const { registry: migrated, migratedCount, totalCount } = migrateOrphans(registry);

  console.error(
    `Migrating orphans[]: ${migratedCount}/${totalCount} string entries converted to object form.`
  );

  if (args.dryRun) {
    console.error('Dry run -- no write.');
    process.exit(0);
  }

  const serialized = sortedJsonStringify(migrated);
  // Atomic write via `.tmp` + rename. Mirrors compute-hashes.mjs:363-368.
  // A crash or SIGINT between writeFileSync and renameSync leaves the original
  // registry intact because the in-place file is never truncated.
  // Spec: sg-sync-registry-gaps sec-data-integrity-migrate-7f89.
  const tmpPath = `${registryPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, serialized);
    renameSync(tmpPath, registryPath);
  } catch (err) {
    // Clean up the tmp file on failure so we don't leak `.tmp` files into the
    // registry directory. Best-effort: if unlink also fails, surface the
    // ORIGINAL write error (the tmp leak is secondary).
    // Spec: sg-sync-registry-gaps cr-observability-7a1f8e02.
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore; tmp file may not exist (write failed before create) or
      // permission error. Surfacing the original err is more useful.
    }
    throw err;
  }
  console.error(`Wrote ${registryPath}`);

  if (!args.noArchive && !args.registryPath) {
    // Only self-archive when running against the real registry.
    try {
      const destPath = selfArchive();
      console.error(`Self-archived to ${destPath}`);
    } catch (err) {
      console.error(`Self-archive failed: ${err.message}`);
      // Non-fatal: registry write already succeeded.
    }
  }
}

// Allow import-as-library without running main (used by unit tests).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1] === __filename;
if (isDirectInvocation) {
  main();
}
