/**
 * Placeholder grammar + substitution engine for runtime connectivity templates.
 *
 * Grammar: `// {{IDENTIFIER}}` where IDENTIFIER matches /^[A-Z][A-Z0-9_]*$/.
 * Single-pass `String.prototype.replaceAll` per placeholder from the
 * substitution map. No conditional logic. No nesting. No secondary substitution.
 *
 * Fail-loud rule (EC-A2): if any `{{…}}` marker remains after the pass, throw
 * UnresolvedPlaceholderError with the unresolved marker(s) and the archetype.
 *
 * @module e2e-test-writer/substitution
 * @contract runtime-connectivity-template-substitution
 * @req REQ-F-001a, REQ-F-001
 */

/**
 * Placeholder grammar regex. Matches the identifier inside `{{IDENTIFIER}}`.
 * Capture group 1 is the identifier. Leading `// ` prefix is NOT part of the
 * identifier match — it is part of the comment wrapper that makes the token
 * a valid JavaScript line comment pre-substitution.
 */
export const PLACEHOLDER_GRAMMAR = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/** Canonical placeholder identifier set (all 5 archetypes share these). */
export const CANONICAL_PLACEHOLDERS = Object.freeze([
  'SPEC_ID',
  'PORT',
  'HOST_DISCOVERY',
  'TIMEOUT_MS',
  'LIVENESS_TIER',
  'PROVISIONING_BLOCK',
]);

/** Archetype-specific placeholder identifier sets. */
export const ARCHETYPE_SPECIFIC_PLACEHOLDERS = Object.freeze({
  'http-smoke': Object.freeze([
    'HTTP_METHOD',
    'HTTP_PATH',
    'REQUEST_SHAPE',
    'RESPONSE_ASSERTION',
  ]),
  'ws-event': Object.freeze([
    'WS_PATH',
    'TRIGGER_ACTION',
    'EXPECTED_EVENT_NAME',
    'EVENT_PAYLOAD_ASSERTION',
  ]),
  'sse-stream': Object.freeze(['SSE_PATH', 'TRIGGER_ACTION', 'EXPECTED_FRAME_ASSERTION']),
  'cli-writes-file': Object.freeze([
    'CLI_INVOCATION',
    'EXPECTED_OUTPUT_PATH',
    'EXPECTED_FILE_CONTENT_ASSERTION',
  ]),
  'ipc-ping-pong': Object.freeze([
    'IPC_CHANNEL',
    'REQUEST_MESSAGE',
    'EXPECTED_RESPONSE_ASSERTION',
  ]),
});

/**
 * @typedef {Object} BuildSubstitutionMapInput
 * @property {string} specId - manifest.id
 * @property {'L1' | 'L2' | 'L3'} [livenessTier]
 * @property {number} [timeoutMs]
 * @property {string} provisioningBlock - resolved scaffold block
 * @property {string} hostDiscovery - resolved host-discovery snippet
 * @property {'http-smoke' | 'ws-event' | 'sse-stream' | 'cli-writes-file' | 'ipc-ping-pong'} archetype
 * @property {Record<string, string>} [archetypeValues] - archetype-specific substitutions
 */

/**
 * Error thrown when substitution completes but unresolved `{{…}}` markers
 * remain in the emitted string (EC-A2).
 */
export class UnresolvedPlaceholderError extends Error {
  /**
   * @param {string[]} markers - Unresolved `{{…}}` marker identifiers.
   * @param {string} archetype - Archetype name.
   */
  constructor(markers, archetype) {
    super(
      `Unresolved placeholder(s) in emitted file for archetype ${archetype}: ${markers.join(', ')}. No partial file written.`,
    );
    this.name = 'UnresolvedPlaceholderError';
    /** @type {string[]} */
    this.markers = markers;
    /** @type {string} */
    this.archetype = archetype;
    /** @type {string} */
    this.code = 'E_UNRESOLVED_PLACEHOLDER';
  }
}

/**
 * Build a canonical substitution map from structured inputs. Archetype-specific
 * values are merged in verbatim. Each value is the full JS fragment that the
 * substitution engine will splice in place of the marker line.
 *
 * The canonical placeholders substitute to statement-level declarations that
 * introduce the corresponding identifiers used by the template body (SPEC_ID,
 * LIVENESS_TIER, TIMEOUT_MS, discoverHost, PORT).
 *
 * @param {BuildSubstitutionMapInput} input
 * @returns {Record<string, string>} map keyed by placeholder identifier (no braces).
 */
export function buildSubstitutionMap(input) {
  const specId = input.specId;
  const livenessTier = input.livenessTier || 'L1';
  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.trunc(input.timeoutMs)
      : 30000;

  const map = {
    SPEC_ID: `const SPEC_ID = ${JSON.stringify(specId)};`,
    PORT: `const PORT = 0;`,
    HOST_DISCOVERY: input.hostDiscovery,
    TIMEOUT_MS: `const TIMEOUT_MS = ${timeoutMs};`,
    LIVENESS_TIER: `const LIVENESS_TIER = ${JSON.stringify(livenessTier)};`,
    PROVISIONING_BLOCK: input.provisioningBlock,
  };

  const specific = ARCHETYPE_SPECIFIC_PLACEHOLDERS[input.archetype];
  if (!specific) {
    throw new Error(`Unknown archetype: ${input.archetype}`);
  }
  const archetypeValues = input.archetypeValues || {};
  for (const id of specific) {
    if (typeof archetypeValues[id] === 'string') {
      map[id] = archetypeValues[id];
    }
  }
  return map;
}

/**
 * Apply the substitution map to a template string. Performs one pass of
 * `String.prototype.replaceAll` per placeholder. Does NOT recurse — values
 * that contain `{{…}}`-like text are spliced literally.
 *
 * Post-substitution, scans for any remaining `{{…}}` markers. If any remain,
 * throws `UnresolvedPlaceholderError`.
 *
 * @param {string} template - Raw template string.
 * @param {Record<string, string>} substitutionMap - Identifier → replacement.
 * @param {string} archetype - Archetype label for error messages.
 * @returns {string} Substituted string with zero `{{…}}` markers remaining.
 * @throws {UnresolvedPlaceholderError} when unresolved markers remain.
 */
export function substitute(template, substitutionMap, archetype) {
  let out = template;
  for (const [id, value] of Object.entries(substitutionMap)) {
    // Spec §Placeholder Grammar: markers are `// {{IDENTIFIER}}` — the
    // leading `// ` comment prefix is part of the marker so the raw template
    // parses cleanly before substitution. Substitution must consume the
    // comment prefix too; otherwise the replacement line stays commented out
    // and declarations never execute at runtime (TECH-003).
    const marker = `// {{${id}}}`;
    out = out.replaceAll(marker, value);
  }
  const remaining = [...out.matchAll(PLACEHOLDER_GRAMMAR)].map((m) => m[1]);
  if (remaining.length > 0) {
    const unique = Array.from(new Set(remaining));
    throw new UnresolvedPlaceholderError(unique, archetype);
  }
  return out;
}
