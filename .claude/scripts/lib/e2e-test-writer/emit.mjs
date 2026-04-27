/**
 * End-to-end runtime connectivity test emission pipeline.
 *
 * Composes archetype selection, template loading, substitution, and
 * scaffold-tier + host-discovery resolution. Returns the substituted test
 * string and the canonical emission path. Does NOT write the file — the
 * caller (agent dispatch or integration test) decides whether to persist.
 *
 * @module e2e-test-writer/emit
 * @contract runtime-connectivity-emission
 * @req REQ-F-001, REQ-F-001a, REQ-F-008
 */

import { selectArchetype } from './archetype-selection.mjs';
import { loadTemplate } from './template-loader.mjs';
import {
  buildSubstitutionMap,
  substitute,
  UnresolvedPlaceholderError,
} from './substitution.mjs';
import { resolveProvisioningBlock } from './scaffold-tier.mjs';
import { resolveHostDiscovery } from './host-discovery.mjs';

/** Error thrown when the emission pipeline rejects the spec input. */
export class EmissionError extends Error {
  /**
   * @param {string} code - Machine-readable code.
   * @param {string} message
   * @param {object} [context]
   */
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'EmissionError';
    /** @type {string} */
    this.code = code;
    /** @type {object} */
    this.context = context;
  }
}

/**
 * @typedef {Object} EmitInput
 * @property {string} specId - manifest.id
 * @property {Record<string, unknown>} frontmatter - Parsed spec frontmatter.
 * @property {Array<Record<string, unknown>>} contracts - Contract definitions from the spec.
 * @property {Record<string, string>} [archetypeValues] - Archetype-specific substitutions.
 * @property {string} [projectRoot] - For template path resolution.
 * @property {string} [templateDir] - Override template directory.
 */

/**
 * @typedef {Object} EmitResult
 * @property {'success' | 'skipped' | 'failed'} status
 * @property {string} [archetype]
 * @property {string} [emissionPath] - `tests/e2e/<specId>.runtime-connectivity.spec.mjs`
 * @property {string} [content] - Substituted test file contents.
 * @property {string} [reason] - Skip / failure rationale.
 * @property {string[]} [diagnostics] - Per-mode diagnostic lines.
 */

/**
 * Evaluate scope gate + archetype selection + substitution and return the
 * emission artifact. Does NOT write to disk.
 *
 * @param {EmitInput} input
 * @returns {EmitResult}
 */
export function emitRuntimeConnectivityTest(input) {
  if (!input || typeof input !== 'object') {
    throw new EmissionError('E_BAD_INPUT', 'emitRuntimeConnectivityTest requires an input object');
  }
  const specId = input.specId;
  const fm = input.frontmatter || {};
  if (typeof specId !== 'string' || specId.length === 0) {
    throw new EmissionError('E_BAD_SPEC_ID', 'emitRuntimeConnectivityTest requires specId');
  }
  if (!/^[a-z0-9-]+$/.test(specId)) {
    throw new EmissionError(
      'E_BAD_SPEC_ID_CHARSET',
      `specId must match /^[a-z0-9-]+$/: ${specId}`,
    );
  }

  // Scope gate — crosses_boundary: false → skip.
  if (fm.crosses_boundary === false) {
    return {
      status: 'skipped',
      reason: `crosses_boundary=false (rationale: ${fm.crosses_boundary_rationale || 'none'})`,
    };
  }
  // Scope gate — e2e_skip: true → skip.
  if (fm.e2e_skip === true) {
    return {
      status: 'skipped',
      reason: `e2e_skip=true (rationale: ${fm.e2e_skip_rationale || 'none'})`,
    };
  }

  // Archetype selection.
  const selection = selectArchetype({
    id: specId,
    frontmatter: fm,
    contracts: /** @type {any} */ (input.contracts || []),
  });
  if (selection.status === 'ambiguous') {
    return {
      status: 'failed',
      diagnostics: [
        `FAILED: Archetype selection ambiguous for spec ${specId}.`,
        `  Matched archetypes: ${(selection.matched || []).join(', ')}`,
        `  Resolution options:`,
        `    (a) decompose the spec to enforce atomicity (one canonical test per spec, per DEC-003)`,
        `    (b) annotate primary archetype in frontmatter (deferred)`,
      ],
      reason: 'ambiguous',
    };
  }
  if (selection.status === 'no-match') {
    return {
      status: 'failed',
      diagnostics: [
        `FAILED: No archetype matched spec ${specId}.`,
        `  Available archetypes: http-smoke, ws-event, sse-stream, cli-writes-file, ipc-ping-pong`,
        `  Resolution options:`,
        `    (a) shape the spec to fit an existing archetype`,
        `    (b) opt out via e2e_skip: true with a valid rationale`,
        `    (c) trigger a PRD amendment adding a 6th archetype`,
      ],
      reason: 'no-match',
    };
  }
  const archetype = selection.archetype;

  // Scaffold tier + host discovery resolution.
  /** @type {{ liveness?: unknown, prefer_ipv6?: unknown }} */
  const runtimeEnv =
    fm.runtime_env && typeof fm.runtime_env === 'object' ? /** @type {any} */ (fm.runtime_env) : {};
  const provisioningBlock = resolveProvisioningBlock(runtimeEnv.liveness, specId);
  const hostDiscovery = resolveHostDiscovery(runtimeEnv.prefer_ipv6);

  const livenessTier =
    runtimeEnv.liveness === 'L1' ||
    runtimeEnv.liveness === 'L2' ||
    runtimeEnv.liveness === 'L3'
      ? runtimeEnv.liveness
      : 'L1';

  const timeoutMs =
    typeof fm.runtime_connectivity_budget_ms === 'number'
      ? fm.runtime_connectivity_budget_ms
      : 30000;

  const substitutionMap = buildSubstitutionMap({
    specId,
    livenessTier,
    timeoutMs,
    provisioningBlock,
    hostDiscovery,
    archetype,
    archetypeValues: input.archetypeValues || {},
  });

  const template = loadTemplate(archetype, {
    projectRoot: input.projectRoot,
    templateDir: input.templateDir,
  });

  /** @type {string} */
  let content;
  try {
    content = substitute(template, substitutionMap, archetype);
  } catch (err) {
    if (err instanceof UnresolvedPlaceholderError) {
      return {
        status: 'failed',
        archetype,
        reason: 'unresolved-placeholder',
        diagnostics: [
          `FAILED: Unresolved placeholder(s) in emitted file for spec ${specId}.`,
          `  Archetype: ${archetype}`,
          `  Unresolved markers: ${err.markers.map((m) => `{{${m}}}`).join(', ')}`,
          `  No partial file written.`,
        ],
      };
    }
    throw err;
  }

  return {
    status: 'success',
    archetype,
    emissionPath: `tests/e2e/${specId}.runtime-connectivity.spec.mjs`,
    content,
  };
}
