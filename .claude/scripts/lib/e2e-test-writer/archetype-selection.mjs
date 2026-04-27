/**
 * Archetype selection heuristic for runtime connectivity smoke tests.
 *
 * Pure function over spec frontmatter + contract definitions. Priority order
 * (first match wins) within the event paradigm; cross-paradigm matches yield
 * AMBIGUOUS. Zero matches yield NO-MATCH. Both failures emit no test file;
 * the agent returns `status: failed` with a diagnostic.
 *
 * Priority table (matches .claude/agents/e2e-test-writer.md § Archetype Selection):
 *   1. SSE channel (`_template: event` + `text/event-stream`) → sse-stream
 *   2. WebSocket channel (`_template: event` + `ws://`/`wss://`) → ws-event
 *   3. REST endpoint (`_template: rest-api`) → http-smoke
 *   4. CLI with file-write side effect (`_template: behavioral`, file-write) → cli-writes-file
 *   5. IPC channel (`_template: behavioral`, IPC request/response) → ipc-ping-pong
 *   6. Multiple archetypes span distinct paradigms → AMBIGUOUS
 *   7. No archetype matches → NO-MATCH
 *
 * Paradigm groups (interpretation-ASM-002 — see spec Assumptions Made):
 *   - event = {sse-stream, ws-event} → within this group, priority order applies
 *     (SSE wins over WS per AC2.5).
 *   - rest = {http-smoke}
 *   - cli = {cli-writes-file}
 *   - ipc = {ipc-ping-pong}
 *   - More than one paradigm matched → AMBIGUOUS (per AC2.3, e.g., REST + WS).
 *
 * @module e2e-test-writer/archetype-selection
 * @contract runtime-connectivity-archetype-selection
 * @req REQ-F-001a
 */

/** @typedef {'http-smoke' | 'ws-event' | 'sse-stream' | 'cli-writes-file' | 'ipc-ping-pong'} Archetype */

/**
 * @typedef {Object} ContractDefinition
 * @property {string} [_template] - Contract template name
 *   ('rest-api' | 'event' | 'behavioral' | 'data-model').
 * @property {string} [channel] - Channel identifier (for event template).
 * @property {string} [behavior] - Behavior summary text (for behavioral template).
 * @property {string} [protocol] - Optional protocol hint.
 * @property {Record<string, string>} [headers] - Optional header hints.
 */

/**
 * @typedef {Object} SpecInput
 * @property {string} id - manifest.id (spec identifier).
 * @property {Record<string, unknown>} [frontmatter] - Parsed spec frontmatter.
 * @property {ContractDefinition[]} contracts - Contract definitions.
 */

/** Canonical archetype enum. Do NOT extend without a PRD amendment. */
export const ARCHETYPES = Object.freeze([
  'http-smoke',
  'ws-event',
  'sse-stream',
  'cli-writes-file',
  'ipc-ping-pong',
]);

/** Sentinel return for EC-A1 (cross-paradigm matches). */
export const ARCHETYPE_SELECTION_AMBIGUOUS = Object.freeze({
  status: 'ambiguous',
  archetype: null,
});

/** Sentinel return for EC-A6 (no priority match). */
export const ARCHETYPE_SELECTION_NO_MATCH = Object.freeze({
  status: 'no-match',
  archetype: null,
});

/** Paradigm group per archetype. */
const ARCHETYPE_PARADIGM = Object.freeze({
  'sse-stream': 'event',
  'ws-event': 'event',
  'http-smoke': 'rest',
  'cli-writes-file': 'cli',
  'ipc-ping-pong': 'ipc',
});

/**
 * @param {ContractDefinition} contract
 * @returns {boolean}
 */
function isSseContract(contract) {
  if (contract._template !== 'event') return false;
  const channel = typeof contract.channel === 'string' ? contract.channel : '';
  if (/text\/event-stream/i.test(channel)) return true;
  const accept =
    contract.headers && typeof contract.headers === 'object'
      ? contract.headers.Accept || contract.headers.accept
      : undefined;
  if (typeof accept === 'string' && /text\/event-stream/i.test(accept)) return true;
  return false;
}

/**
 * @param {ContractDefinition} contract
 * @returns {boolean}
 */
function isWsContract(contract) {
  if (contract._template !== 'event') return false;
  // Exclude SSE (already classified).
  if (isSseContract(contract)) return false;
  const channel = typeof contract.channel === 'string' ? contract.channel : '';
  if (/^wss?:\/\//i.test(channel)) return true;
  if (
    typeof contract.protocol === 'string' &&
    /^websocket$/i.test(contract.protocol)
  ) {
    return true;
  }
  // Generic event contract without SSE markers → treat as WS by default.
  return true;
}

/**
 * @param {ContractDefinition} contract
 * @returns {boolean}
 */
function isRestContract(contract) {
  return contract._template === 'rest-api';
}

/**
 * @param {ContractDefinition} contract
 * @returns {boolean}
 */
function isCliWritesFileContract(contract) {
  if (contract._template !== 'behavioral') return false;
  const behavior =
    typeof contract.behavior === 'string' ? contract.behavior.toLowerCase() : '';
  return /(writes? (a |the )?file|creates? (a |an |the )?file|output file|file output)/i.test(
    behavior,
  );
}

/**
 * @param {ContractDefinition} contract
 * @returns {boolean}
 */
function isIpcContract(contract) {
  if (contract._template !== 'behavioral') return false;
  // Exclude cli-writes-file (already classified).
  if (isCliWritesFileContract(contract)) return false;
  const behavior =
    typeof contract.behavior === 'string' ? contract.behavior.toLowerCase() : '';
  return /(ipc|inter-process|unix (domain )?socket|named pipe|ping.?pong)/i.test(
    behavior,
  );
}

/**
 * Run the archetype selection heuristic.
 *
 * @param {SpecInput} spec
 * @returns {{ status: 'ok', archetype: Archetype } | { status: 'ambiguous', archetype: null, matched: Archetype[] } | typeof ARCHETYPE_SELECTION_NO_MATCH}
 */
export function selectArchetype(spec) {
  if (!spec || !Array.isArray(spec.contracts)) {
    return ARCHETYPE_SELECTION_NO_MATCH;
  }

  /** @type {Set<Archetype>} */
  const matched = new Set();
  for (const contract of spec.contracts) {
    if (!contract || typeof contract !== 'object') continue;
    if (isSseContract(contract)) {
      matched.add('sse-stream');
      continue;
    }
    if (isRestContract(contract)) {
      matched.add('http-smoke');
      continue;
    }
    if (isCliWritesFileContract(contract)) {
      matched.add('cli-writes-file');
      continue;
    }
    if (isIpcContract(contract)) {
      matched.add('ipc-ping-pong');
      continue;
    }
    if (isWsContract(contract)) {
      matched.add('ws-event');
      continue;
    }
  }

  // Paradigm grouping.
  const paradigms = new Set();
  for (const archetype of matched) {
    paradigms.add(ARCHETYPE_PARADIGM[archetype]);
  }

  // Priority 6: cross-paradigm matches → AMBIGUOUS (per AC2.3).
  if (paradigms.size > 1) {
    return Object.freeze({
      status: 'ambiguous',
      archetype: null,
      matched: /** @type {Archetype[]} */ (Array.from(matched)),
    });
  }

  // Priority 7: no match.
  if (matched.size === 0) {
    return ARCHETYPE_SELECTION_NO_MATCH;
  }

  // Within event paradigm: SSE wins over WS (per AC2.5).
  if (matched.has('sse-stream')) {
    return { status: 'ok', archetype: 'sse-stream' };
  }
  if (matched.has('ws-event')) {
    return { status: 'ok', archetype: 'ws-event' };
  }
  // Single paradigm, single archetype.
  const [archetype] = matched;
  return { status: 'ok', archetype: /** @type {Archetype} */ (archetype) };
}
