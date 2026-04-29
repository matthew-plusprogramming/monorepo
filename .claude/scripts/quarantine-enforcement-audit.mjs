#!/usr/bin/env node

/**
 * Quarantine CLI — seal a broken rtc-enforcement audit log + start a new log
 * whose first entry cryptographically references the sealed file's bytes.
 *
 * Owner doc: .claude/docs/RTC-ENFORCEMENT-AUDIT.md.
 * Requirements: REQ-NFR-025 (recovery ritual, chain-of-custody).
 *
 * CLI arguments:
 *   --reason=<string>       REQUIRED — human-readable quarantine rationale.
 *   --operator=<string>     REQUIRED — operator identity recorded on the entry.
 *   --log-path=<path>       OPTIONAL — defaults to
 *                           .claude/audit/rtc-enforcement-changes.log.
 *   --date=<YYYY-MM-DDTHH-MM-SS>
 *                           OPTIONAL — deterministic datetime tag for the
 *                           sealed file. Defaults to now()
 *                           formatted ISO-datetime (F-018 fix) so routine
 *                           collisions are rare.
 *
 * Exit codes:
 *   0  — quarantine succeeded.
 *   1  — usage error (missing --reason / --operator).
 *   2  — filesystem error (log missing, sealed path exists, rename failed).
 *
 * Algorithm:
 *   1. Read existing log bytes.
 *   2. Compute SHA-256(bytes).hex() → quarantined_file_sha256.
 *   3. Rename log → <log>.<date>.quarantine  (fs.renameSync — atomic same-fs).
 *   4. Append one `quarantine` entry to the NEW log (appendEntry handles
 *      genesis prev_hash).
 *   5. Print JSON result to stdout, exit 0.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { appendEntry } from './lib/enforcement-audit-writer.mjs';

const DEFAULT_LOG_PATH = '.claude/audit/rtc-enforcement-changes.log';

/**
 * Parse a long-option argv array into a shallow map.
 * Accepts both `--key=value` and `--key value` forms.
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = '';
      }
    }
  }
  return out;
}

/**
 * Format a Date as YYYY-MM-DDTHH-MM-SS (F-018 fix — ISO datetime, colons
 * replaced with dashes so it is safe as a filename suffix).
 * @param {Date} d
 */
function defaultDateTag(d) {
  const iso = d.toISOString();
  // `2026-04-20T12:00:00.000Z` → `2026-04-20T12-00-00`
  return iso.replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const reason = args.reason;
  const operator = args.operator;
  if (!reason || !operator) {
    process.stderr.write(
      'usage: quarantine-enforcement-audit.mjs --reason=<r> --operator=<op> [--log-path=<p>] [--date=<YYYY-MM-DDTHH-MM-SS>]\n',
    );
    process.exit(1);
    return;
  }

  const logPath = args['log-path'] || DEFAULT_LOG_PATH;
  const dateTag = args.date || defaultDateTag(new Date());

  if (!existsSync(logPath)) {
    process.stderr.write(
      `quarantine: log file missing at ${logPath}\n`,
    );
    process.exit(2);
    return;
  }

  const quarantinedPath = `${logPath}.${dateTag}.quarantine`;
  if (existsSync(quarantinedPath)) {
    process.stderr.write(
      `quarantine: sealed path already exists at ${quarantinedPath}; re-invoke with explicit --date=<YYYY-MM-DDTHH-MM-SS>\n`,
    );
    process.exit(2);
    return;
  }

  // 1–2. Read + hash.
  let bytes;
  try {
    bytes = readFileSync(logPath);
  } catch (err) {
    process.stderr.write(
      `quarantine: failed to read log at ${logPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
    return;
  }
  const quarantinedHash = createHash('sha256').update(bytes).digest('hex');

  // 3. Rename — atomic on same filesystem.
  try {
    renameSync(logPath, quarantinedPath);
  } catch (err) {
    process.stderr.write(
      `quarantine: failed to seal log: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
    return;
  }

  // 4. Append quarantine entry to new log.
  try {
    appendEntry(
      {
        decision_type: 'quarantine',
        operator,
        quarantined_file_sha256: quarantinedHash,
        quarantine_reason: reason,
      },
      { logPath },
    );
  } catch (err) {
    process.stderr.write(
      `quarantine: sealed ${quarantinedPath} but failed to append quarantine entry: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
    return;
  }

  // 5. Emit JSON result.
  process.stdout.write(
    JSON.stringify({
      status: 'quarantined',
      quarantined_path: quarantinedPath,
      new_log_path: logPath,
      quarantined_file_sha256: quarantinedHash,
    }) + '\n',
  );
  process.exit(0);
}

try {
  const selfPath = fileURLToPath(import.meta.url);
  if (process.argv[1] && resolve(process.argv[1]) === selfPath) {
    main();
  }
} catch {
  // Loaded as module — skip CLI.
}
