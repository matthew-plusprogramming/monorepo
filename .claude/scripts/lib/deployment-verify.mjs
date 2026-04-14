/**
 * Deployment Verification Runners
 *
 * Helper functions for executing verify:build and verify:deploy scripts,
 * including HTTP GET fallback for post-deploy smoke tests.
 *
 * All verification results are logged with structured JSON to stderr
 * and session.json state is updated via atomicModifyJSON.
 *
 * Implements: AC-3 (Build Verification), AC-4 (Post-Deploy Smoke Test),
 *             AC-6 (Fail-Open), AC-8 (Structured Audit Logging)
 *
 * Spec: sg-deployment-verification-gaps
 */

import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicModifyJSON } from './atomic-write.mjs';
import { findClaudeDir } from './hook-utils.mjs';

// =============================================================================
// Constants
// =============================================================================

/** Timeout for verify:build execution (5 minutes, NF1). */
const VERIFY_BUILD_TIMEOUT_MS = 300_000;

/** Timeout for verify:deploy / HTTP GET fallback (30 seconds, NF5). */
const SMOKE_TEST_TIMEOUT_MS = 30_000;

/** HTTP status codes that count as PASS for smoke test. */
const PASS_STATUS_CODES = [200, 401, 403];

/** User-Agent header for HTTP fallback requests. */
const HTTP_USER_AGENT = 'metaclaude-assistant/deployment-verify';

// =============================================================================
// Internal Utilities
// =============================================================================

/**
 * Resolve .claude directory via shared hook-utils (supports CLAUDE_PROJECT_DIR for test isolation).
 * @returns {string} Absolute path to .claude directory
 */
function resolveClaudeDir() {
  return findClaudeDir(import.meta.url);
}

/**
 * Get the session.json path.
 */
function getSessionPath() {
  return join(resolveClaudeDir(), 'context', 'session.json');
}

/**
 * Emit a structured audit log entry to stderr. (AC-8.1)
 *
 * @param {object} entry - Audit log entry with required fields
 */
function logAudit(entry) {
  process.stderr.write(JSON.stringify(entry) + '\n');
}

/**
 * Read the consumer project's package.json to check for scripts.
 * Looks in the project root (parent of .claude directory).
 *
 * @returns {object|null} Parsed package.json or null if not found/invalid
 */
function readConsumerPackageJson() {
  const claudeDir = resolveClaudeDir();
  const projectRoot = join(claudeDir, '..');
  const packageJsonPath = join(projectRoot, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Determine if a URL is a localhost target (for TLS skip). (AC-4.5)
 *
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isLocalhostUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Determine if a URL requires TLS skip (localhost + HTTPS). (AC-4.5)
 *
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function needsLocalhostTlsSkip(url) {
  try {
    const parsed = new URL(url);
    return isLocalhostUrl(url) && parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Well-known cloud metadata IP addresses that must be blocked (SSRF prevention). */
const BLOCKED_METADATA_HOSTS = [
  '169.254.169.254',  // AWS/GCP/Azure metadata endpoint
  'fd00::',           // IPv6 unique-local (metadata range)
  'metadata.google.internal',
  '100.100.100.200',  // Alibaba Cloud metadata
];

/**
 * Validate an endpoint URL for safety before use in fetch or command execution.
 * Blocks non-HTTP(S) schemes and well-known cloud metadata endpoints (SSRF prevention).
 *
 * @param {string} url - URL to validate
 * @throws {Error} If URL is invalid, has non-HTTP(S) scheme, or targets a metadata endpoint
 */
export function validateEndpointUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid endpoint URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid URL scheme "${parsed.protocol}" -- only http: and https: are allowed`);
  }

  if (BLOCKED_METADATA_HOSTS.includes(parsed.hostname)) {
    throw new Error(`Blocked metadata endpoint: ${parsed.hostname}`);
  }
}

// =============================================================================
// verify:build Runner (AC-3, AC-8)
// =============================================================================

/**
 * Execute the consumer project's verify:build script and record the result.
 *
 * - Resolves actual script command text from package.json (AC-3.2, AC-8.2)
 * - Interprets exit 0 as PASS, non-zero as FAIL (AC-3.1)
 * - Updates deployment.verify_build_passed in session.json (AC-3.3)
 * - Emits advisory warning if verify:build is not declared (AC-6.1)
 *
 * @param {object} [options] - Options
 * @param {string} [options.cwd] - Working directory for script execution
 * @returns {{ result: string, exitCode: number, command: string }}
 */
export function runVerifyBuild(options = {}) {
  const packageJson = readConsumerPackageJson();
  const scripts = packageJson?.scripts || {};

  // AC-6.1: Fail-open when verify:build not declared
  if (!scripts['verify:build']) {
    const warning = 'No verify:build script -- deployment verification skipped';
    process.stderr.write(`[deployment-verify] WARNING: ${warning}\n`);
    logAudit({
      event: 'verify_build_skipped',
      result: 'SKIP',
      timestamp: new Date().toISOString(),
      command: null,
      exit_code: null,
      reason: warning,
    });
    return { result: 'SKIP', exitCode: null, command: null };
  }

  // AC-3.2, AC-8.2: Resolve actual script command text from package.json
  const resolvedCommand = scripts['verify:build'];
  const cwd = options.cwd || join(resolveClaudeDir(), '..');

  let exitCode = 0;
  let stdout = '';
  let stderr = '';

  try {
    // AC-3.1: Execute verify:build (using execFileSync to avoid shell injection)
    const output = execFileSync('npm', ['run', 'verify:build'], {
      cwd,
      timeout: VERIFY_BUILD_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    stdout = output || '';
  } catch (err) {
    exitCode = err.status || 1;
    stdout = err.stdout || '';
    stderr = err.stderr || '';
  }

  const result = exitCode === 0 ? 'PASS' : 'FAIL';

  // AC-8.1, AC-8.2: Structured audit log with resolved command text
  logAudit({
    event: 'verify_build_complete',
    result,
    timestamp: new Date().toISOString(),
    command: resolvedCommand,
    exit_code: exitCode,
  });

  // AC-3.3: Update session.json if PASS
  if (result === 'PASS') {
    const sessionPath = getSessionPath();
    try {
      atomicModifyJSON(sessionPath, (current) => {
        const s = current || {};
        if (s.deployment) {
          s.deployment.verify_build_passed = true;
        }
        s.updated_at = new Date().toISOString();
        return s;
      });
    } catch {
      process.stderr.write('[deployment-verify] WARNING: Failed to update session.json with verify_build_passed\n');
    }
  }

  return { result, exitCode, command: resolvedCommand };
}

// =============================================================================
// verify:deploy Runner with HTTP GET Fallback (AC-4, AC-8)
// =============================================================================

/**
 * Execute the consumer project's verify:deploy script or HTTP GET fallback.
 *
 * Priority:
 * 1. If verify:deploy script exists, execute it with endpoint URL (AC-4.1)
 * 2. If no script but endpoint URL available, HTTP GET fallback (AC-4.2)
 * 3. If neither, advisory warning and return SKIP (AC-6.2)
 *
 * HTTP GET fallback behavior (AC-4.3, AC-4.4, AC-4.5):
 * - 200/401/403 = PASS
 * - 5xx/timeout/connection-error = FAIL
 * - No-follow-redirects, skip TLS for localhost, standard User-Agent
 * - 30-second timeout (AC-4.6)
 *
 * @param {object} [options] - Options
 * @param {string} [options.endpointUrl] - Deployed endpoint URL
 * @param {string} [options.cwd] - Working directory for script execution
 * @returns {Promise<{ result: string, exitCode: number, command: string, endpointUrl?: string }>}
 */
export async function runVerifyDeploy(options = {}) {
  const { endpointUrl, cwd: cwdOpt } = options;
  const packageJson = readConsumerPackageJson();
  const scripts = packageJson?.scripts || {};
  const hasVerifyDeploy = 'verify:deploy' in scripts;

  // Case 1: verify:deploy script exists (AC-4.1)
  if (hasVerifyDeploy) {
    // Pass packageJson to avoid redundant re-read (Fix 6)
    return runVerifyDeployScript(endpointUrl, cwdOpt, packageJson);
  }

  // Case 2: No script but endpoint URL available -- HTTP GET fallback (AC-4.2)
  if (endpointUrl) {
    // Validate URL before making any network request (SSRF prevention)
    validateEndpointUrl(endpointUrl);
    return runHttpGetFallback(endpointUrl);
  }

  // Case 3: Neither script nor endpoint URL (AC-6.2)
  const warning = 'No verify:deploy script and no endpoint URL -- smoke test skipped';
  process.stderr.write(`[deployment-verify] WARNING: ${warning}\n`);
  logAudit({
    event: 'verify_deploy_skipped',
    result: 'SKIP',
    timestamp: new Date().toISOString(),
    command: null,
    exit_code: null,
    reason: warning,
  });
  return { result: 'SKIP', exitCode: null, command: null };
}

/**
 * Run the verify:deploy npm script with endpoint URL as first argument.
 *
 * @param {string} [endpointUrl] - Endpoint URL to pass to script
 * @param {string} [cwd] - Working directory
 * @param {object} [packageJson] - Pre-loaded package.json (avoids redundant re-read)
 * @returns {{ result: string, exitCode: number, command: string, endpointUrl?: string }}
 */
function runVerifyDeployScript(endpointUrl, cwd, packageJson) {
  const resolvedCwd = cwd || join(resolveClaudeDir(), '..');
  const resolvedCommand = packageJson?.scripts?.['verify:deploy'] || 'verify:deploy';

  // Validate endpointUrl before passing to child process (shell injection prevention)
  if (endpointUrl) {
    validateEndpointUrl(endpointUrl);
  }

  // AC-4.1: Pass endpoint URL as first argument (using execFileSync to avoid shell injection)
  const args = endpointUrl
    ? ['run', 'verify:deploy', '--', endpointUrl]
    : ['run', 'verify:deploy'];

  let exitCode = 0;

  try {
    execFileSync('npm', args, {
      cwd: resolvedCwd,
      timeout: SMOKE_TEST_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    exitCode = err.status || 1;
  }

  const result = exitCode === 0 ? 'PASS' : 'FAIL';

  // AC-8.1: Structured audit log
  logAudit({
    event: 'verify_deploy_complete',
    result,
    timestamp: new Date().toISOString(),
    command: resolvedCommand,
    exit_code: exitCode,
    endpoint_url: endpointUrl || null,
  });

  // AC-4.7: Update session.json if PASS
  if (result === 'PASS') {
    updateVerifyDeployPassed();
  }

  return { result, exitCode, command: resolvedCommand, endpointUrl };
}

/**
 * Perform an HTTPS GET with per-request TLS verification disabled.
 * Uses node:https directly to avoid mutating process.env.NODE_TLS_REJECT_UNAUTHORIZED
 * which is process-global and creates a race condition with concurrent requests.
 *
 * @param {string} url - HTTPS URL to GET
 * @returns {Promise<number>} HTTP status code
 */
function httpsGetStatusCode(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      rejectUnauthorized: false, // AC-4.5: skip TLS for localhost
      headers: {
        'User-Agent': HTTP_USER_AGENT,
      },
      timeout: SMOKE_TEST_TIMEOUT_MS,
    };

    const req = https.get(options, (res) => {
      // Consume response body to free socket
      res.resume();
      resolve(res.statusCode);
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      const timeoutErr = new Error('Request timed out');
      timeoutErr.code = 'ETIMEDOUT';
      reject(timeoutErr);
    });
  });
}

/**
 * HTTP GET fallback smoke test. (AC-4.2 through AC-4.6)
 *
 * @param {string} endpointUrl - URL to GET
 * @returns {Promise<{ result: string, exitCode: number, command: string, endpointUrl: string }>}
 */
async function runHttpGetFallback(endpointUrl) {
  const command = `HTTP GET ${endpointUrl}`;
  const skipTls = needsLocalhostTlsSkip(endpointUrl);

  let result = 'FAIL';
  let exitCode = -1;
  let auditLogged = false;

  try {
    let statusCode;

    if (skipTls) {
      // AC-4.5: For localhost HTTPS, use node:https with per-request rejectUnauthorized:false.
      // This avoids mutating process.env.NODE_TLS_REJECT_UNAUTHORIZED which is process-global
      // and creates a race condition with concurrent HTTPS requests.
      statusCode = await httpsGetStatusCode(endpointUrl);
    } else {
      // Non-localhost or HTTP: use standard fetch
      const fetchOptions = {
        method: 'GET',
        redirect: 'manual', // no-follow-redirects
        headers: {
          'User-Agent': HTTP_USER_AGENT,
        },
        signal: AbortSignal.timeout(SMOKE_TEST_TIMEOUT_MS), // AC-4.6: 30s timeout
      };
      const response = await fetch(endpointUrl, fetchOptions);
      statusCode = response.status;
    }

    // AC-4.3: 200/401/403 = PASS
    if (PASS_STATUS_CODES.includes(statusCode)) {
      result = 'PASS';
      exitCode = 0;
    } else if (statusCode >= 500) {
      // AC-4.4: 5xx = FAIL
      result = 'FAIL';
      exitCode = statusCode;
    } else {
      // Other status codes (3xx, 4xx other than 401/403) -- treated as FAIL
      result = 'FAIL';
      exitCode = statusCode;
    }
  } catch (err) {
    // AC-4.4: timeout or connection error = FAIL
    result = 'FAIL';
    exitCode = -1;

    if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
      // AC-4.6: Timeout recorded as FAIL with timeout-specific audit event.
      // Mark auditLogged to prevent duplicate post-try audit entry (chk-audit-d9f3b5c7).
      logAudit({
        event: 'verify_deploy_timeout',
        result: 'FAIL',
        timestamp: new Date().toISOString(),
        command,
        exit_code: -1,
        endpoint_url: endpointUrl,
        timeout_ms: SMOKE_TEST_TIMEOUT_MS,
      });
      auditLogged = true;
    }
  }

  // AC-8.1: Structured audit log (skip if already logged in catch block to prevent duplicates)
  if (!auditLogged) {
    logAudit({
      event: 'verify_deploy_complete',
      result,
      timestamp: new Date().toISOString(),
      command,
      exit_code: exitCode,
      endpoint_url: endpointUrl,
    });
  }

  // AC-4.7: Update session.json if PASS
  if (result === 'PASS') {
    updateVerifyDeployPassed();
  }

  return { result, exitCode, command, endpointUrl };
}

/**
 * Update deployment.verify_deploy_passed=true in session.json. (AC-4.7)
 */
function updateVerifyDeployPassed() {
  const sessionPath = getSessionPath();
  try {
    atomicModifyJSON(sessionPath, (current) => {
      const s = current || {};
      if (s.deployment) {
        s.deployment.verify_deploy_passed = true;
        s.deployment.verified = true; // Legacy compat
      }
      s.updated_at = new Date().toISOString();
      return s;
    });
  } catch {
    process.stderr.write('[deployment-verify] WARNING: Failed to update session.json with verify_deploy_passed\n');
  }
}
