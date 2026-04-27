/**
 * EnforcementModeResolver — session-over-file-over-default precedence.
 *
 * Spec: sg-e2e-enforcement-flag-audit as-007 / parent spec.md
 *       §Interfaces-&-Contracts (EnforcementModeResolver behavioral contract)
 * Requirements: REQ-NFR-015 (enforcement-flag precedence + session discipline).
 *
 * Precedence (inv-med-9d7a1c85 codification):
 *   1. Session override → source: 'session'
 *      - Reject sessionOverride === 'off' with SESSION_CANNOT_SET_OFF (EDGE-FA-08).
 *   2. File mode AND effective_at <= now → source: 'file'
 *      - Emit clock-skew warning (non-blocking) when |now - effective_at| > 5min.
 *   3. File mode AND effective_at > now → NOT-YET-EFFECTIVE → fall through.
 *   4. File absent OR exhausted → source: 'default' (default = 'advisory'
 *      unless caller supplies `default` option).
 *
 * File-malformed cases bubble out as structured errors:
 *   FLAG_FILE_MALFORMED       — JSON parse failure (EDGE-FA-10)
 *   FLAG_VALIDATION_FAILED    — Zod schema rejection
 *
 * File-absent is NOT an error — returns the default.
 */

import { existsSync, readFileSync } from 'node:fs';

import { parseFlagStructural } from './enforcement-flag-schema.mjs';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

const DEFAULT_FLAG_PATH = '.claude/config/runtime-connectivity-enforcement.json';

/**
 * Build a structured resolver error with stable `code` field.
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 */
function makeError(code, message, detail = {}) {
  const err = new Error(message);
  /** @type {any} */ (err).code = code;
  /** @type {any} */ (err).detail = detail;
  return err;
}

/**
 * Resolve effective enforcement mode.
 *
 * @param {{
 *   sessionOverride?: 'advisory' | 'coercive' | 'off',
 *   default?: 'advisory' | 'coercive' | 'off',
 *   flagPath?: string,
 *   now?: Date,
 *   onWarn?: (msg: string) => void,
 * }} [opts]
 * @returns {{mode: string, source: 'session' | 'file' | 'default'}}
 */
export function resolveMode(opts = {}) {
  const {
    sessionOverride,
    default: defaultMode = 'advisory',
    flagPath = DEFAULT_FLAG_PATH,
    now = new Date(),
    onWarn,
  } = opts;

  // 1. Session override precedence (with 'off' rejection per EDGE-FA-08).
  if (sessionOverride !== undefined) {
    if (sessionOverride === 'off') {
      throw makeError(
        'SESSION_CANNOT_SET_OFF',
        'Session override cannot set mode=off; only the out-of-band flag file may disable enforcement',
      );
    }
    return { mode: sessionOverride, source: 'session' };
  }

  // 2/3. File precedence (if present).
  if (existsSync(flagPath)) {
    const bytes = readFileSync(flagPath, 'utf-8');
    const parsed = parseFlagStructural(bytes);
    if (!parsed.success) {
      throw makeError(parsed.error.code, parsed.error.message, {
        issues: parsed.error.issues,
      });
    }
    const { mode, effective_at } = parsed.data;
    const effectiveMs = new Date(effective_at).getTime();
    const nowMs = now.getTime();

    if (effectiveMs > nowMs) {
      // 3. Not-yet-effective → fall through to default.
      return { mode: defaultMode, source: 'default' };
    }

    // 2. Effective — emit skew warning if |now - effective| > 5min.
    if (Math.abs(nowMs - effectiveMs) > FIVE_MINUTES_MS) {
      const msg = `[enforcement-mode-resolver] clock-skew: effective_at=${effective_at} differs from now=${now.toISOString()} by > 5min`;
      if (typeof onWarn === 'function') {
        onWarn(msg);
      } else {
        process.stderr.write(msg + '\n');
      }
    }

    return { mode, source: 'file' };
  }

  // 4. Fall through to default.
  return { mode: defaultMode, source: 'default' };
}
