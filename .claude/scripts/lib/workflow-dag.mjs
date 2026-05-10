/**
 * Shared Workflow DAG Module
 *
 * Extracted from session-checkpoint.mjs to provide a single source of truth
 * for workflow DAG definitions, enforcement constants, and query functions.
 * Consumed by both the cooperative layer (session-checkpoint.mjs) and the
 * coercive layer (enforcement hooks).
 *
 * Implements: REQ-001, REQ-002
 *
 * Amended: sg-workflow-convergence-bugs / ws-dag-substages
 *   - as-001c: VALID_SUBSTAGES enum, REQUIRED_SUBSTAGES_BY_WORKFLOW,
 *              PHASE_REQUIRED_SUBSTAGE, CHALLENGING_SUBSTAGE_NODES.
 *   - as-003c: validateSubstages() obligation-check function.
 *   - as-005c: malformed substages_visited detection branches in
 *              validateSubstages (dag.substage.malformed log).
 *   - as-006c: legacy bare-challenging visit ignore
 *              (dag.substage.legacy_visit_ignored log).
 */

import { createHash } from 'node:crypto';
// sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-016 / REQ-009 / AC16.1–AC16.3:
// execFileSync is used synchronously by runComputeHashesGate() to invoke
// `compute-hashes.mjs --verify` at the post-impl → pre-unify phase-transition
// boundary. Synchronous semantics are load-bearing for the ordering contract
// (AC16.3) — the throw path must run inline with the caller's stack so a
// caller `process.exit(2)` aborts BEFORE any queued SubagentStop recorder.
import { execFileSync as nodeExecFileSync } from 'node:child_process';
// sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-008 / REQ-007 / AC8.2:
// Worktree env-parity enforcement wired at phase-transition validator entry.
// enforceEnvParity(pin) rejects CLAUDE_PROJECT_DIR mid-session mutation
// (current env var canonicalizes to a different root than the pin captured
// by as-006 at start-work). Legacy-session guard: when the pin is absent
// (pre-as-006 session), enforcement is skipped transparently.
import {
  enforceEnvParity as enforceEnvParityHelper,
  WORKTREE_PATH_VIOLATION as WORKTREE_PATH_VIOLATION_CONST,
} from './worktree-enforcement.mjs';

// =============================================================================
// DAG Constants
// =============================================================================

/**
 * Predecessor graph for orchestrator workflow.
 * Keys use parameterized encoding: "challenging:<stage>" maps to challenger
 * dispatch with that stage value, not a literal phase name in VALID_PHASES.
 *
 * REQ-003 (sg-pipeline-efficiency-ws1-convergence-pruning / as-023):
 *   `challenging:pre-test` deleted; `testing` now depends directly on
 *   `implementing`. Formerly-pre-test-scoped advisories are folded into the
 *   `/unify` preflight block (see `.claude/scripts/lib/unify-preflight.mjs`).
 *
 * REQ-004 (sg-pipeline-efficiency-ws1-convergence-pruning / as-024):
 *   `challenging:pre-review` deleted; `reviewing` now depends directly on
 *   `verifying`. Formerly-pre-review-scoped reviewer-focus signal is folded
 *   into the `code-reviewer` / `security-reviewer` dispatch-prompt context
 *   via `.claude/scripts/lib/reviewer-focus-metadata.mjs` (EC-10 persistence).
 */
export const ORCHESTRATOR_PREDECESSORS = {
  'spec_authoring': ['prd_gathering'],
  'atomizing': ['spec_authoring'],
  'enforcing': ['atomizing'],
  'investigating': ['enforcing'],
  'challenging:pre-orchestration': ['investigating'],
  'auto_approval': ['challenging:pre-orchestration'],
  'implementing': ['auto_approval'],
  'testing': ['implementing'],
  'verifying': ['testing'],
  'reviewing': ['verifying'],
  'completion_verifying': ['reviewing'],
  'documenting': ['completion_verifying'],
  'complete': ['documenting'],
};

/**
 * Predecessor graph for oneoff-spec workflow.
 *
 * REQ-003 (sg-pipeline-efficiency-ws1-convergence-pruning / as-023):
 *   `challenging:pre-test` deleted; `testing` now depends directly on
 *   `implementing`. See ORCHESTRATOR_PREDECESSORS for rationale.
 *
 * REQ-004 (sg-pipeline-efficiency-ws1-convergence-pruning / as-024):
 *   `challenging:pre-review` deleted; `reviewing` now depends directly on
 *   `verifying`. See ORCHESTRATOR_PREDECESSORS for rationale.
 */
export const ONEOFF_SPEC_PREDECESSORS = {
  'spec_authoring': ['prd_gathering'],
  'investigating': ['spec_authoring'],
  'challenging:pre-implementation': ['investigating'],
  'auto_approval': ['challenging:pre-implementation'],
  'implementing': ['auto_approval'],
  'testing': ['implementing'],
  'verifying': ['testing'],
  'reviewing': ['verifying'],
  'completion_verifying': ['reviewing'],
  'documenting': ['completion_verifying'],
  'complete': ['documenting'],
};

/**
 * Workflow types exempt from enforcement.
 * Includes journal-only per DEC-003.
 * @type {string[]}
 */
export const EXEMPT_WORKFLOWS = ['oneoff-vibe', 'refactor', 'journal-only'];

/**
 * Valid workflow types (5 entries).
 * Single source of truth — consumed by session-validate.mjs and verified
 * against session.schema.json by enum-sync.test.mjs.
 * @type {string[]}
 */
export const VALID_WORKFLOWS = [
  'oneoff-vibe',
  'oneoff-spec',
  'orchestrator',
  'refactor',
  'journal-only'
];

/**
 * Valid phase values (16 entries).
 * Single source of truth — consumed by session-validate.mjs and verified
 * against session.schema.json by enum-sync.test.mjs.
 *
 * NOTE: `manual-test` is intentionally excluded from DAG phases. It is
 * advisory by default and conditionally enforced by the Stop hook when spec
 * frontmatter declares runtime_validation_required: true.
 * @type {string[]}
 */
export const VALID_PHASES = [
  'prd_gathering',
  'spec_authoring',
  'atomizing',
  'enforcing',
  'investigating',
  'awaiting_approval',
  'auto_approval',
  'implementing',
  'testing',
  'verifying',
  'reviewing',
  'journaling',
  'complete',
  'challenging',
  'completion_verifying',
  'documenting'
];

/**
 * Valid subagent types (23 entries).
 * Single source of truth — consumed by session-validate.mjs and verified
 * against session.schema.json by enum-sync.test.mjs.
 * @type {string[]}
 */
export const VALID_SUBAGENT_TYPES = [
  'explore',
  'spec-author',
  'atomizer',
  'atomicity-enforcer',
  'interface-investigator',
  'implementer',
  'test-writer',
  'e2e-test-writer',
  'unifier',
  'code-reviewer',
  'security-reviewer',
  'doc-auditor',
  'documenter',
  'refactorer',
  'facilitator',
  'manual-tester',
  'prd-writer',
  'prd-critic',
  'prd-reader',
  'prd-amender',
  'challenger',
  'completion-verifier',
  'flow-verifier',
  'unknown_fallback'
];

/**
 * Mandatory dispatches per phase per workflow.
 * Used by SubagentStop advisory hooks and completion checklist.
 *
 * REQ-003 (as-023): pre-test challenger dispatch removed from the testing
 * phase. Formerly-pre-test-scoped advisories now run via `/unify` preflight
 * (see `.claude/scripts/lib/unify-preflight.mjs`). The `testing` phase
 * therefore has no mandatory dispatches beyond the implicit test-writer path.
 *
 * REQ-004 (as-024): pre-review challenger dispatch removed from the reviewing
 * phase. Formerly-pre-review-scoped reviewer-focus signal now surfaces as
 * dispatch-prompt context via `.claude/scripts/lib/reviewer-focus-metadata.mjs`.
 */
export const MANDATORY_DISPATCHES = {
  orchestrator: {
    'implementing': [{ type: 'challenger', stage: 'pre-orchestration' }],
    'reviewing': [{ type: 'code-reviewer' }],
    'complete': [{ type: 'completion-verifier' }, { type: 'documenter' }],
  },
  'oneoff-spec': {
    'implementing': [{ type: 'challenger', stage: 'pre-implementation' }],
    'reviewing': [{ type: 'code-reviewer' }],
    'complete': [{ type: 'completion-verifier' }, { type: 'documenter' }],
  },
};

/**
 * Required challenger stages per workflow.
 *
 * REQ-003 (as-023) — AC23.2: MANDATORY_STAGES (this table) SHALL NOT include
 * `pre-test`.
 * REQ-004 (as-024) — AC24.1: MANDATORY_STAGES SHALL NOT include `pre-review`.
 * Only pre-orchestration (orchestrator) / pre-implementation (oneoff-spec)
 * remain as required challenger stages.
 */
export const REQUIRED_CHALLENGER_STAGES = {
  orchestrator: ['pre-orchestration'],
  'oneoff-spec': ['pre-implementation'],
};

/**
 * Flat union of all required challenger stages across workflows. Mirrors the
 * parent spec's "MANDATORY_STAGES" phrasing (§REQ-003/REQ-004) — this is the
 * authoritative container tests inspect to assert stage removal. Derived
 * from REQUIRED_CHALLENGER_STAGES so the two stay in lock-step.
 *
 * REQ-004 (as-024) — AC24.1 enforcement: this export SHALL NOT contain
 * `pre-review` (nor the namespaced `challenging:pre-review`). As-023
 * established that `pre-test` was removed here; as-024 completes the pair.
 *
 * @type {readonly string[]}
 */
export const MANDATORY_STAGES = Object.freeze([
  ...new Set([
    ...REQUIRED_CHALLENGER_STAGES.orchestrator,
    ...REQUIRED_CHALLENGER_STAGES['oneoff-spec'],
  ]),
]);

// =============================================================================
// Enforcement Table for Coercive Hooks
// =============================================================================

/**
 * Subagent types subject to coercive gate enforcement.
 * Non-enforced types pass through without prerequisite checks.
 * @type {string[]}
 */
export const ENFORCED_SUBAGENT_TYPES = [
  'implementer',
  'test-writer',
  'e2e-test-writer',
  'code-reviewer',
  'security-reviewer',
  'documenter',
  'completion-verifier',
];

/**
 * Mandatory dispatches checked by the Stop hook.
 * The Stop hook checks for the presence of dispatch records (any status)
 * for these four subagent types.
 * @type {string[]}
 */
export const STOP_MANDATORY_DISPATCHES = [
  'code-reviewer',
  'security-reviewer',
  'completion-verifier',
  'documenter',
  'e2e-test-writer',
];

/**
 * Phase-aware dispatch requirements for the Stop hook.
 *
 * Maps session phases to the set of mandatory Stop-hook dispatches required
 * when the session is ending at that phase. Phases not listed require zero
 * dispatches (pre-implementation and implementation phases).
 *
 * @type {Record<string, string[]>}
 */
export const STOP_PHASE_REQUIREMENTS = {
  // Pre-implementation phases: no dispatches required (implicit default)
  // Implementation phases: no dispatches required (implicit default)

  // Review phases
  reviewing: ['code-reviewer', 'security-reviewer', 'e2e-test-writer'],
  completion_verifying: ['code-reviewer', 'security-reviewer', 'completion-verifier', 'e2e-test-writer'],

  // Terminal phases
  documenting: ['code-reviewer', 'security-reviewer', 'completion-verifier', 'documenter', 'e2e-test-writer'],
  complete: ['code-reviewer', 'security-reviewer', 'completion-verifier', 'documenter', 'e2e-test-writer'],
};

/**
 * Risk tiers emitted by /route and consumed by Stop-hook dispatch enforcement.
 *
 * Missing or invalid risk_tier values intentionally resolve to trust-bearing
 * so legacy or malformed sessions keep the previous full gate stack.
 * @type {readonly string[]}
 */
export const VALID_RISK_TIERS = Object.freeze([
  'trust-bearing',
  'user-visible',
  'shared-library',
  'local-feature',
  'docs-prompt-metadata',
  'mechanical-cleanup',
]);

export const DEFAULT_RISK_TIER = 'trust-bearing';

/**
 * Stop-hook mandatory dispatches by risk tier.
 *
 * `trust-bearing` preserves the historical STOP_PHASE_REQUIREMENTS table.
 * Lower tiers only enforce the subagent dispatches that map to their route
 * gate plan; phase-transition and manifest checks remain separate gates.
 * @type {Record<string, Record<string, string[]>>}
 */
export const STOP_PHASE_REQUIREMENTS_BY_RISK_TIER = Object.freeze({
  'trust-bearing': STOP_PHASE_REQUIREMENTS,
  'user-visible': Object.freeze({
    reviewing: Object.freeze(['code-reviewer', 'e2e-test-writer']),
    completion_verifying: Object.freeze(['code-reviewer', 'e2e-test-writer']),
    documenting: Object.freeze(['code-reviewer', 'e2e-test-writer']),
    complete: Object.freeze(['code-reviewer', 'e2e-test-writer']),
  }),
  'shared-library': Object.freeze({
    reviewing: Object.freeze(['code-reviewer']),
    completion_verifying: Object.freeze(['code-reviewer']),
    documenting: Object.freeze(['code-reviewer']),
    complete: Object.freeze(['code-reviewer']),
  }),
  'local-feature': Object.freeze({
    reviewing: Object.freeze(['code-reviewer']),
    completion_verifying: Object.freeze(['code-reviewer']),
    documenting: Object.freeze(['code-reviewer']),
    complete: Object.freeze(['code-reviewer']),
  }),
  'docs-prompt-metadata': Object.freeze({}),
  'mechanical-cleanup': Object.freeze({}),
});

/**
 * Normalize a route risk tier with trust-bearing as the fail-closed default.
 *
 * @param {unknown} riskTier
 * @returns {string}
 */
export function normalizeRiskTier(riskTier) {
  return typeof riskTier === 'string' && VALID_RISK_TIERS.includes(riskTier)
    ? riskTier
    : DEFAULT_RISK_TIER;
}

/**
 * Read the session's risk tier, defaulting to trust-bearing for legacy state.
 *
 * @param {object} session
 * @returns {string}
 */
export function getRiskTierStrict(session) {
  return normalizeRiskTier(session?.active_work?.risk_tier);
}

/**
 * Return phase-scoped Stop-hook dispatch requirements for a risk tier.
 *
 * @param {string} phase
 * @param {string|object} riskTierOrSession - Risk-tier string or session object
 * @returns {string[]}
 */
export function getStopPhaseRequirements(phase, riskTierOrSession) {
  const riskTier = typeof riskTierOrSession === 'string'
    ? normalizeRiskTier(riskTierOrSession)
    : getRiskTierStrict(riskTierOrSession);
  const byPhase =
    STOP_PHASE_REQUIREMENTS_BY_RISK_TIER[riskTier] ||
    STOP_PHASE_REQUIREMENTS_BY_RISK_TIER[DEFAULT_RISK_TIER];
  return [...(byPhase[phase] || [])];
}

/**
 * Valid rationale values for e2e_skip opt-out in spec frontmatter.
 * Shared across spec validation hooks and the stop hook for defense-in-depth.
 *
 * Shared opt-out contract for default E2E dispatch.
 * @type {string[]}
 */
export const VALID_E2E_SKIP_RATIONALES = [
  'pure-refactor',
  'test-infra',
  'type-only',
  'docs-only',
  'pure-compute',
];

/**
 * Valid runtime validation surfaces for specs that require a live manual-test
 * gate. This marker is intentionally separate from risk_tier and runtime_env:
 * it asks whether static/generated gates are insufficient for the changed
 * runtime-loaded surface.
 * @type {readonly string[]}
 */
export const VALID_RUNTIME_VALIDATION_SURFACES = Object.freeze([
  'plugin',
  'mcp',
  'connector',
  'browser-extension',
  'dynamic-tool-body',
  'plugin-loader',
  'other',
]);

/**
 * Override gate name mapping.
 * Maps prerequisite conditions to canonical gate names for gate-override.json.
 */
export const OVERRIDE_GATE_NAMES = {
  investigation: 'investigation',
  investigation_convergence: 'investigation_convergence',
  challenger_convergence: 'challenger_convergence',
  challenge_pre_impl: 'challenge_pre_impl',
  challenge_pre_orchestration: 'challenge_pre_orchestration',
  implementer_dispatch: 'implementer_dispatch',
  challenge_pre_review: 'challenge_pre_review',
  unifier_dispatch: 'unifier_dispatch',
  code_review_convergence: 'code_review_convergence',
  security_review_convergence: 'security_review_convergence',
  documenter_dispatch: 'documenter_dispatch',
  stop_mandatory_dispatches: 'stop_mandatory_dispatches',
  runtime_manual_test: 'runtime_manual_test',
  status_obligations: 'status_obligations',
};

/**
 * Number of consecutive clean passes required for a convergence gate.
 * Referenced by getPrerequisites() when building convergence prerequisites.
 * @type {number}
 */
export const REQUIRED_CLEAN_PASSES = 2;

/**
 * Valid convergence gate names for the update-convergence command.
 * @type {string[]}
 */
export const VALID_CONVERGENCE_GATES = ['code_review', 'security_review', 'investigation', 'challenger', 'unifier', 'completion_verifier'];

/**
 * PerGateThresholdTable -- canonical per-gate convergence threshold,
 * attestation mode, and hash-input manifest map.
 *
 * Re-exported from the content module so downstream readers have a single
 * import site (`workflow-dag.mjs`) for DAG plus threshold state.
 * See `.claude/scripts/lib/per-gate-threshold-table.mjs` for initial content,
 * seeding rationale (REQ-001, REQ-002), and Zod validation details (AC2.6).
 *
 * Spec: sg-pipeline-efficiency-ws1-convergence-pruning / as-002 (AC2.5).
 */
export { PerGateThresholdTable } from './per-gate-threshold-table.mjs';

/**
 * Valid challenger substage enum values (closed set).
 *
 * Source of truth for the `substages_visited.<phase>` array element enum and
 * for `REQUIRED_SUBSTAGES_BY_WORKFLOW`. Verified against
 * session.schema.json by `enum-sync.test.mjs`.
 *
 * Spec: sg-workflow-convergence-bugs (ws-dag-substages) — as-001c.
 * Requirements: REQ-011, REQ-014, REQ-017.
 * Contract: `contract-substages-visited-schema` (owned by ws-dag-substages).
 *
 * NOTE: Pre-REQ-003/004 the canonical short forms were `pre-impl` /
 * `pre-test` / `pre-review` / `pre-orch`. After REQ-004 (as-024) deletion of
 * the pre-review dispatch, only `pre-impl` / `pre-test` / `pre-orch` remain
 * valid. `pre-test` retained for in-flight session compatibility (as-030
 * migration); `pre-review` removed outright because AC24.5 requires no
 * exported surface surfaces it. The predecessor graph uses
 * `pre-implementation` / `pre-orchestration` verbose forms as dispatch-record
 * stage values. Mapping between the two is handled at the `transition-phase`
 * populate call site (see as-002c) so the attribute set uses the short enum
 * canonical form.
 *
 * REQ-004 (as-024): `pre-review` removed from VALID_SUBSTAGES. The
 * `PHASE_REQUIRED_SUBSTAGE.reviewing` entry is already removed above, and
 * `REQUIRED_SUBSTAGES_BY_WORKFLOW` no longer references it. Historical
 * sessions carrying a visited `pre-review` substage are tolerated (the
 * validator treats unknown substages as no-ops); they simply do not gate.
 *
 * @type {readonly string[]}
 */
export const VALID_SUBSTAGES = Object.freeze([
  'pre-impl',
  'pre-test',
  'pre-orch',
]);

/**
 * Workflow-scoped required substage sets (TECH-201 supersedes TECH-102).
 *
 * Spec: sg-workflow-convergence-bugs (ws-dag-substages) — as-004c.
 * Requirements: REQ-011 (sub-stage isolation, workflow-scoped extension),
 *               REQ-017 (semantic preservation).
 * Authoritative: tech.context.md L253-264, L273.
 *
 * REQ-003 (sg-pipeline-efficiency-ws1-convergence-pruning / as-023):
 *   `pre-test` removed from required substage sets — pre-test challenger
 *   dispatch is deleted; testing phase transitions no longer require a
 *   pre-test substage visit. The `pre-test` enum value itself is preserved
 *   in `VALID_SUBSTAGES` for in-flight session compatibility (see as-030
 *   migration); it is simply no longer REQUIRED.
 *
 * REQ-004 (sg-pipeline-efficiency-ws1-convergence-pruning / as-024):
 *   `pre-review` removed from required substage sets — pre-review challenger
 *   dispatch is deleted; reviewing phase transitions no longer require a
 *   pre-review substage visit. The `pre-review` enum value is not in
 *   `VALID_SUBSTAGES`; historical sessions carrying it are tolerated by the
 *   validator as non-gating unknown entries.
 *
 * - oneoff-spec: {pre-impl} (1)
 * - orchestrator: {pre-orch} (1; pre-impl does NOT apply to orchestrator
 *   per TECH-201)
 * - oneoff-vibe, refactor, journal-only: exempt (empty set)
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const REQUIRED_SUBSTAGES_BY_WORKFLOW = Object.freeze({
  'oneoff-spec': Object.freeze(['pre-impl']),
  'orchestrator': Object.freeze(['pre-orch']),
  'oneoff-vibe': Object.freeze([]),
  'refactor': Object.freeze([]),
  'journal-only': Object.freeze([]),
});

/**
 * Phase → required substage mapping (derived from MANDATORY_DISPATCHES).
 *
 * Maps a target phase (the phase the operator is transitioning TO) to the
 * challenger sub-stage that must be present in `substages_visited.challenging`
 * BEFORE the transition is admitted. Phases not listed require no sub-stage
 * (empty set).
 *
 * The mapping derives from the pre-existing MANDATORY_DISPATCHES table:
 * whichever sub-stage the challenger is dispatched with prior to the target
 * phase is the required sub-stage for that target. The workflow-scoped
 * required set (REQUIRED_SUBSTAGES_BY_WORKFLOW) is intersected with this
 * mapping at obligation-check time.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const PHASE_REQUIRED_SUBSTAGE = Object.freeze({
  orchestrator: Object.freeze({
    // pre-orchestration (pre-orch short form) required before implementing
    implementing: 'pre-orch',
    // REQ-003 (as-023): testing phase no longer requires pre-test substage —
    // challenger pre-test dispatch deleted; advisories folded into /unify.
    // REQ-004 (as-024): reviewing phase no longer requires pre-review
    // substage — challenger pre-review dispatch deleted; reviewer-focus
    // signal folded into code-reviewer / security-reviewer dispatch prompts
    // (see reviewer-focus-metadata.mjs).
  }),
  'oneoff-spec': Object.freeze({
    // pre-implementation (pre-impl short form) required before implementing
    implementing: 'pre-impl',
    // REQ-003 (as-023): testing phase no longer requires pre-test substage.
    // REQ-004 (as-024): reviewing phase no longer requires pre-review substage.
  }),
});

/**
 * Substage node identifiers used by the obligation/enforcement layer.
 *
 * These four named constants are additive first-class node identifiers
 * distinct from the bare `challenging` PHASE_OBLIGATIONS key. They provide
 * addressable handles for downstream consumer code / error messages / logs
 * referring to individual challenger sub-stages.
 *
 * Spec: sg-workflow-convergence-bugs (ws-dag-substages) — as-001c.
 *
 * NOTE (REQ-018 semantic preservation): the pre-existing
 * `ORCHESTRATOR_PREDECESSORS` / `ONEOFF_SPEC_PREDECESSORS` constants continue
 * to use their parameterized `challenging:<stage>` keys unchanged; these
 * node identifiers live alongside, not replacing them.
 *
 * @type {readonly string[]}
 */
export const CHALLENGING_SUBSTAGE_NODES = Object.freeze([
  'challenging-pre-impl',
  // REQ-003 (as-023): `challenging-pre-test` node removed — pre-test
  // challenger dispatch deleted. The `pre-test` enum value is retained in
  // VALID_SUBSTAGES for in-flight session compatibility (as-030 migration).
  // REQ-004 (as-024): `challenging-pre-review` node removed — pre-review
  // challenger dispatch deleted. `pre-review` is not in VALID_SUBSTAGES.
  'challenging-pre-orch',
]);

// =============================================================================
// Phase Obligations (Status Obligation Enforcement)
// =============================================================================

/**
 * Static phase-to-obligation mapping.
 * Each entry defines the manifest fields that must have specific values
 * when leaving (exiting) the specified phase.
 *
 * Field paths use dot notation for nested fields:
 * - "review_state" -> manifest.review_state
 * - "convergence.spec_complete" -> manifest.convergence.spec_complete
 *
 * 14 obligation entries across 9 phases. Entry-semantics obligations
 * (e.g., work_state = IMPLEMENTING) are checked at exit time alongside
 * exit-semantics obligations (TECH-101 resolution).
 *
 * Implements status-obligation phase mapping.
 */
export const PHASE_OBLIGATIONS = Object.freeze({
  spec_authoring: Object.freeze([
    Object.freeze({ field: 'review_state', expected: 'DRAFT' }),
    Object.freeze({ field: 'convergence.spec_complete', expected: true }),
  ]),
  investigating: Object.freeze([
    Object.freeze({ field: 'convergence.investigation_converged', expected: true }),
  ]),
  challenging: Object.freeze([
    Object.freeze({ field: 'convergence.challenger_converged', expected: true }),
  ]),
  implementing: Object.freeze([
    Object.freeze({ field: 'work_state', expected: 'IMPLEMENTING' }),
    Object.freeze({ field: 'convergence.all_acs_implemented', expected: true }),
  ]),
  testing: Object.freeze([
    Object.freeze({ field: 'convergence.all_tests_passing', expected: true }),
  ]),
  verifying: Object.freeze([
    Object.freeze({ field: 'convergence.unifier_passed', expected: true }),
    Object.freeze({ field: 'work_state', expected: 'VERIFYING' }),
  ]),
  reviewing: Object.freeze([
    Object.freeze({ field: 'convergence.code_review_passed', expected: true }),
    Object.freeze({ field: 'convergence.security_review_passed', expected: true }),
  ]),
  completion_verifying: Object.freeze([
    Object.freeze({ field: 'convergence.completion_verification_passed', expected: true }),
  ]),
  documenting: Object.freeze([
    Object.freeze({ field: 'convergence.docs_generated', expected: true }),
    Object.freeze({ field: 'work_state', expected: 'READY_TO_MERGE' }),
  ]),
});

/**
 * Resolve a dot-notation field path against an object.
 * Returns undefined if any segment is missing.
 *
 * @param {string} path - Dot-notation field path (e.g., "convergence.spec_complete")
 * @param {object} obj - Object to resolve against
 * @returns {*} The resolved value, or undefined if any segment is missing
 */
function resolveFieldPath(path, obj) {
  const segments = path.split('.');
  let current = obj;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    // SEC-002: Guard against prototype pollution via crafted field paths
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

// =============================================================================
// as-008 / REQ-007 / AC8.2: env-parity enforcement at phase-transition entry
// =============================================================================

/**
 * Resolve the session-level project_dir_pin from a passed session object,
 * preferring the explicit argument and falling back to the session passed
 * via options. Returns null for legacy sessions (no pin field).
 *
 * @param {object|null|undefined} session
 * @returns {string|null}
 */
function resolvePinFromSession(session) {
  const pin = session?.active_work?.project_dir_pin;
  return typeof pin === 'string' && pin.length > 0 ? pin : null;
}

/**
 * Phase-transition env-parity guard. Invoked at the entry of
 * `validateObligations()` and `validateSubstages()` to reject mid-session
 * `CLAUDE_PROJECT_DIR` mutation.
 *
 * Legacy-session guard: when `session.active_work.project_dir_pin` is absent
 * (pre-as-006 session), enforcement is skipped and the validator proceeds
 * with its existing checks. This preserves zero-regression deployment for
 * in-flight sessions.
 *
 * On violation, the underlying helper throws an Error with:
 *   { code: 'WORKTREE_PATH_VIOLATION', reason: 'env-mutation',
 *     attempted_path, pinned_root, exit_code: 2 }
 *
 * Callers (validateObligations / validateSubstages) rethrow so the hook
 * wrapper emits exit-2 + audit entry per AC8.2.
 *
 * Exported for direct invocation by phase-transition consumers that do not
 * flow through validateObligations/validateSubstages (e.g., compute-hashes
 * gate-ordering hook in ws-1 as-024).
 *
 * @param {object|null|undefined} session - Parsed session.json object.
 * @throws {Error} with `code === 'WORKTREE_PATH_VIOLATION'` on env-mutation.
 *
 * @req REQ-007
 * @ac AC8.2
 * @spec sg-pipeline-efficiency-ws3-orchestrator-hygiene as-008
 */
export function enforceEnvParity(session) {
  const pin = resolvePinFromSession(session);
  if (pin === null) return; // legacy-session guard (Task 4)
  enforceEnvParityHelper(pin, { session });
}

/**
 * Re-export of WORKTREE_PATH_VIOLATION constant so consumers of
 * workflow-dag.mjs can catch-and-rebrand enforceEnvParity violations without
 * importing worktree-enforcement.mjs separately. Identical value to the
 * source constant by design (single source of truth).
 *
 * @type {string}
 */
export const WORKTREE_PATH_VIOLATION = WORKTREE_PATH_VIOLATION_CONST;

// =============================================================================
// as-016 / REQ-009 / AC16.1–AC16.4: compute-hashes gate ordering — post-impl → pre-unify hook
// =============================================================================
//
// Phase-transition hook that invokes `compute-hashes.mjs --verify` at the
// post-impl → pre-unify checkpoint. In the DAG this corresponds to the
// `testing → verifying` transition: post-implementation (implementer +
// test-writer convergence reached, phase `testing` exits) and before unifier
// runs (phase `verifying`). The hook name "post-impl → pre-unify" is the
// contract-declared label (spec.md §Core Flows Flow 4); the underlying DAG
// phases are `testing` (post-impl) and `verifying` (pre-unify).
//
// Ordering contract (AC16.3, load-bearing): on `compute-hashes --verify`
// exit 2 (drift detected), the hook MUST abort the session BEFORE the
// PostToolUse convergence-recorder gets a chance to append a ritual
// clean-pass entry. This is enforced by:
//   1. Synchronous execFileSync invocation inside the phase-transition path.
//   2. Callers MUST `process.exit(2)` (or rethrow) on non-zero exit before
//      continuing — see session-checkpoint.mjs opTransitionPhase.
//   3. Because SubagentStop events (which trigger the recorder) serialize
//      after the current tool's postscript, an exit inside the hook aborts
//      the event loop before the recorder runs.
//
// Pre-impl removal (AC16.4): there is no pre-impl compute-hashes dispatch
// in the facilitator workflow or agent prompts. The PostToolUse registry
// hash-verify hook at `.claude/settings.json` is a continuous safety net
// (fires on every `.claude/**` write, not phase-scoped) — it is orthogonal
// to the phase-transition hook and retained.
//
// Late-stage secondary detection (Task 4): retained via the
// `registry-hash-verify` gate at `.claude/completion-gates.md` (completion
// -verifier runs `compute-hashes.mjs --verify` as a blocking gate at
// completion time). Not owned by this module — only cross-referenced.

/**
 * Source phase label for the compute-hashes phase-transition hook.
 * Contract-declared per spec.md §Core Flows Flow 4; maps to DAG phase
 * `testing` (implementer + test-writer convergence reached).
 * @type {string}
 */
export const COMPUTE_HASHES_HOOK_SOURCE_PHASE = 'post-impl';

/**
 * Target phase label for the compute-hashes phase-transition hook.
 * Contract-declared per spec.md §Core Flows Flow 4; maps to DAG phase
 * `verifying` (unifier dispatched, convergence-recorder active).
 * @type {string}
 */
export const COMPUTE_HASHES_HOOK_TARGET_PHASE = 'pre-unify';

/**
 * DAG-phase mapping for the post-impl → pre-unify contract labels.
 * The transition fires when the session moves from `testing` (post-impl)
 * to `verifying` (pre-unify). Exported for callers that need to decide
 * whether to invoke the hook for a given (from, to) pair.
 *
 * @type {{ from: string, to: string }}
 */
export const COMPUTE_HASHES_HOOK_PHASE_TRANSITION = Object.freeze({
  from: 'testing',
  to: 'verifying',
});

/**
 * CLI flag passed to `compute-hashes.mjs` when invoked by the phase-transition
 * hook. Contract-declared: the hook invokes `compute-hashes.mjs --verify`
 * (not `--update`, not bare display). Any other mode is a contract violation.
 * @type {string}
 */
export const COMPUTE_HASHES_VERIFY_FLAG = '--verify';

/**
 * Structured error code emitted when the compute-hashes drift check fails
 * at the post-impl → pre-unify hook. Callers that catch the thrown error
 * can branch on `.code` and emit audit entries with event_class
 * `compute_hashes`. Mirrors `COMPUTE_HASHES_LOCK_TIMEOUT` from as-015.
 * @type {string}
 */
export const COMPUTE_HASHES_DRIFT = 'COMPUTE_HASHES_DRIFT';

/**
 * Decide whether the post-impl → pre-unify compute-hashes hook should fire
 * for a given (from, to) phase pair.
 *
 * The hook fires on the `testing → verifying` transition only. All other
 * transitions are passthrough no-ops. Exempt workflows (oneoff-vibe,
 * refactor, journal-only) also skip the hook because they have no
 * compute-hashes → unifier contract.
 *
 * @param {string} fromPhase - Outgoing phase (VALID_PHASES member).
 * @param {string} toPhase - Incoming phase (VALID_PHASES member).
 * @param {string|null|undefined} workflow - Workflow string (orchestrator | oneoff-spec | ...).
 * @returns {boolean} True iff the hook should invoke compute-hashes --verify.
 *
 * @spec sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-016 / AC16.1
 * @req REQ-009
 */
export function shouldRunComputeHashesHook(fromPhase, toPhase, workflow) {
  if (fromPhase !== COMPUTE_HASHES_HOOK_PHASE_TRANSITION.from) return false;
  if (toPhase !== COMPUTE_HASHES_HOOK_PHASE_TRANSITION.to) return false;
  if (workflow && EXEMPT_WORKFLOWS.includes(workflow)) return false;
  return true;
}

/**
 * Execute the compute-hashes drift verification at the post-impl → pre-unify
 * phase-transition boundary.
 *
 * Behavior:
 *   - Invokes `node <scriptsDir>/compute-hashes.mjs --verify` synchronously.
 *   - On exit 0 → returns `{ exitCode: 0, drift: false }`; caller may proceed
 *     to dispatch the unifier. The PostToolUse convergence-recorder is
 *     allowed to fire.
 *   - On non-zero exit (drift detected, lock timeout, structural error) →
 *     throws an Error with `code === COMPUTE_HASHES_DRIFT`, `.exitCode`
 *     carrying the child exit code, and `.stderr` carrying the truncated
 *     child stderr. Callers MUST propagate the abort (e.g.,
 *     `process.exit(2)`) BEFORE any SubagentStop / PostToolUse recorder
 *     can fire — this is the ordering contract (AC16.3).
 *
 * Ordering contract (AC16.3): this function returns synchronously via
 * `execFileSync`; the throw path runs inline with the caller's stack, so a
 * `process.exit(2)` inside the caller's catch block aborts the process
 * before Node's event loop drains (no queued microtask can fire the
 * recorder). The recorder is a separate process spawned by the Claude Code
 * SubagentStop hook — it cannot run until the current tool invocation
 * completes. By exiting 2 here we guarantee the recorder sees "process
 * aborted" rather than "clean phase-transition completed".
 *
 * @param {object} [options]
 * @param {string} [options.scriptsDir] - Override scripts dir (tests only).
 *   Defaults to `<repoRoot>/.claude/scripts`.
 * @param {string} [options.computeHashesCli] - Override CLI path (tests only).
 *   When provided, this path is invoked directly with the `--verify` flag.
 * @param {number} [options.timeoutMs] - Override spawn timeout (default 60s).
 * @returns {{ exitCode: 0, drift: false, stderr: string, stdout: string }}
 *   Clean pass result. Always has exitCode=0; drift=false when returned.
 * @throws {Error} with `code === COMPUTE_HASHES_DRIFT` on non-zero exit.
 *
 * @spec sg-pipeline-efficiency-ws3-orchestrator-hygiene / as-016
 * @req REQ-009
 * @ac AC16.1, AC16.2, AC16.3
 */
export function runComputeHashesGate(options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 60_000;
  const cliPath = options.computeHashesCli
    ? options.computeHashesCli
    : `${options.scriptsDir || defaultScriptsDir()}/compute-hashes.mjs`;

  // Test-only override: allow tests to inject a fake execFileSync without
  // touching the production import graph.
  const execFn = options._execFileSync || nodeExecFileSync;

  let result;
  try {
    result = execFn(process.execPath, [cliPath, COMPUTE_HASHES_VERIFY_FLAG], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // execFileSync throws on any non-zero exit. Re-brand as COMPUTE_HASHES_DRIFT
    // so callers can branch deterministically.
    const exitCode = typeof err.status === 'number' ? err.status : 2;
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    const wrapped = new Error(
      `compute-hashes ${COMPUTE_HASHES_VERIFY_FLAG} exited ${exitCode} at ${COMPUTE_HASHES_HOOK_SOURCE_PHASE} → ${COMPUTE_HASHES_HOOK_TARGET_PHASE} hook`
    );
    wrapped.code = COMPUTE_HASHES_DRIFT;
    wrapped.exitCode = exitCode;
    wrapped.stderr = stderr;
    wrapped.stdout = stdout;
    wrapped.hookPhaseFrom = COMPUTE_HASHES_HOOK_SOURCE_PHASE;
    wrapped.hookPhaseTo = COMPUTE_HASHES_HOOK_TARGET_PHASE;
    throw wrapped;
  }

  return {
    exitCode: 0,
    drift: false,
    stderr: '',
    stdout: typeof result === 'string' ? result : '',
  };
}

/**
 * Default scripts directory resolver. Returns `<repoRoot>/.claude/scripts`.
 * Derived from the module's own path rather than process.cwd() so the hook
 * works regardless of invocation directory.
 *
 * @returns {string}
 * @private
 */
function defaultScriptsDir() {
  // workflow-dag.mjs is at .claude/scripts/lib/workflow-dag.mjs; scripts dir
  // is one level up.
  const modUrl = import.meta.url;
  // Resolve file path from import.meta.url without path imports (keep deps lean).
  const prefix = 'file://';
  const modPath = modUrl.startsWith(prefix) ? modUrl.slice(prefix.length) : modUrl;
  // Strip trailing `/lib/workflow-dag.mjs` to get scripts dir.
  const marker = '/lib/workflow-dag.mjs';
  const idx = modPath.lastIndexOf(marker);
  if (idx === -1) {
    // Fallback: return relative path. The caller should pass scriptsDir
    // explicitly when this module is bundled or renamed.
    return '.claude/scripts';
  }
  return modPath.slice(0, idx);
}

/**
 * Validate manifest fields against obligations for a given phase.
 *
 * Uses strict equality (===) for all comparisons -- no truthy coercion (REQ-012).
 * Missing fields (undefined) are returned as null in the violation report (REQ-011).
 * Returns { passed: true, violations: [] } for phases with no obligations (AC-1.3).
 *
 * Implements status-obligation validation.
 *
 * as-008 (REQ-007 / AC8.2): when a non-null `session` is provided, the
 * validator calls `enforceEnvParity(session)` BEFORE running obligation
 * checks. Env-mutation violations surface as thrown Error objects with
 * `code === 'WORKTREE_PATH_VIOLATION'`; callers must catch and route per
 * AC8.2 (exit 2 + audit entry). The `session` parameter is optional — when
 * omitted (callers that have no session at hand), env-parity enforcement is
 * skipped and legacy behavior is preserved.
 *
 * @param {string} phase - Phase being left (outgoing phase)
 * @param {object} manifest - Parsed manifest.json object
 * @param {{ session?: object }} [options] - Optional session for env-parity enforcement.
 * @returns {{ passed: boolean, violations: Array<{field: string, expected: any, actual: any}> }}
 * @throws {Error} with code='WORKTREE_PATH_VIOLATION' on env-mutation when session provided.
 */
export function validateObligations(phase, manifest, options = {}) {
  // as-008 / AC8.2: env-parity check at validator entry. Legacy-guarded
  // inside enforceEnvParity — a missing pin is a no-op.
  if (options.session !== undefined) {
    enforceEnvParity(options.session);
  }
  const obligations = PHASE_OBLIGATIONS[phase];
  if (!obligations || obligations.length === 0) {
    return { passed: true, violations: [] };
  }

  const violations = [];
  for (const { field, expected } of obligations) {
    const actual = resolveFieldPath(field, manifest);
    if (actual !== expected) { // strict equality (===)
      violations.push({ field, expected, actual: actual === undefined ? null : actual });
    }
  }

  return { passed: violations.length === 0, violations };
}

// =============================================================================
// Substage Obligation Check (as-003c / as-005c / as-006c)
// =============================================================================

/**
 * Maximum observed_value length in malformed log emission. Truncating to 200
 * chars bounds log cardinality against adversary-crafted session.json files
 * with enormous malformed values (R-C7 mitigation, parent spec §Security).
 * @type {number}
 */
const MALFORMED_OBSERVED_VALUE_MAX_LEN = 200;

/**
 * Hash a raw session identifier into a 16-char SHA-256 digest prefix.
 *
 * Structured log lines (R-019) include `session_id` hash, never the raw
 * path or identifier, to avoid leaking filesystem paths in audit logs.
 *
 * Mirrors the `hashSessionId` helper in session-checkpoint.mjs (sole-writer
 * module); duplicated here because workflow-dag.mjs has no dependency on
 * session-checkpoint.mjs (the reverse direction only).
 *
 * @param {string|null|undefined} sessionId - Raw session identifier
 * @returns {string} 16-char hex digest prefix, or "<unknown>"
 */
function hashSessionIdForLog(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return '<unknown>';
  try {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  } catch {
    return '<unknown>';
  }
}

/**
 * Emit a structured log line to stderr in JSON format.
 *
 * Silent on serialization failure — structured logging must never throw
 * from an enforcement path.
 *
 * Contract: `contract-structured-log-keys` (MasterSpec
 * sg-workflow-convergence-bugs). Keys emitted from this module:
 *   - dag.substage.skipped {phase, substage, session_id}
 *   - dag.substage.malformed {gate, observed_type, observed_value, session_id}
 *   - dag.substage.legacy_visit_ignored {phase, session_id}
 *
 * Writes to BOTH console.error AND process.stderr.write so tests using
 * either intercept strategy (console monkey-patch OR stderr.write spy)
 * can observe emitted lines. Production runtime: both paths route to the
 * same stderr fd -- downstream log consumers deduplicate on content.
 *
 * @param {string} event - Closed-enum event name
 * @param {object} fields - Structured field payload
 */
function emitSubstageLog(event, fields) {
  let line;
  try {
    line = JSON.stringify({ event, ...fields });
  } catch {
    // Never throw from logging path; silent failure preferable.
    return;
  }
  try {
    console.error(line);
  } catch {
    // Swallow console failures.
  }
  try {
    process.stderr.write(line + '\n');
  } catch {
    // Swallow stderr failures.
  }
}

/**
 * Truncate a value for inclusion in `dag.substage.malformed.observed_value`.
 *
 * JSON-serialize when possible; on JSON.stringify throw (circular refs,
 * BigInt, etc.), fall back to `String(value)`. Truncate to
 * MALFORMED_OBSERVED_VALUE_MAX_LEN (200) chars.
 *
 * @param {*} value - Arbitrary value to serialize
 * @returns {string} Truncated string representation
 */
function truncateObservedValue(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
    if (serialized === undefined) {
      // JSON.stringify returns undefined for functions, symbols, undefined
      serialized = String(value);
    }
  } catch {
    serialized = String(value);
  }
  if (serialized.length > MALFORMED_OBSERVED_VALUE_MAX_LEN) {
    return serialized.slice(0, MALFORMED_OBSERVED_VALUE_MAX_LEN);
  }
  return serialized;
}

/**
 * Classify the runtime type of a value for malformed log emission.
 *
 * Distinguishes arrays from plain objects (typeof both is 'object'), and
 * null from object. Returns a canonical string: 'string', 'number', 'boolean',
 * 'object', 'array', 'null', 'undefined', 'function', 'symbol', 'bigint'.
 *
 * @param {*} value
 * @returns {string}
 */
function classifyObservedType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Resolve the required substage for a target phase + workflow, if any.
 *
 * Returns the single required substage string (closed-enum member) or null
 * when the target phase does not require any substage under the given
 * workflow (e.g., `auto_approval`, `verifying`, `complete`).
 *
 * Exempt workflows (oneoff-vibe, refactor, journal-only) always return null.
 *
 * @param {string} targetPhase - VALID_PHASES member
 * @param {string} workflow - VALID_WORKFLOWS member
 * @returns {string|null}
 */
function getRequiredSubstageForPhase(targetPhase, workflow) {
  if (EXEMPT_WORKFLOWS.includes(workflow)) return null;
  const mapping = PHASE_REQUIRED_SUBSTAGE[workflow];
  if (!mapping) return null;
  const required = mapping[targetPhase];
  if (!required) return null;
  // Intersect with workflow-scoped required set — required substage must be
  // in the declared set for this workflow. Defensive: enforces TECH-201 if
  // the PHASE_REQUIRED_SUBSTAGE table gets out of sync with
  // REQUIRED_SUBSTAGES_BY_WORKFLOW.
  const workflowSet = REQUIRED_SUBSTAGES_BY_WORKFLOW[workflow] || [];
  if (!workflowSet.includes(required)) return null;
  return required;
}

/**
 * Inspect session.substages_visited shape for the target phase; returns
 * malformed classification if present.
 *
 * Detection layers:
 *   1. Top-level `substages_visited` must be a plain object (not string,
 *      number, boolean, null, or array) -> 'non_object_top'.
 *   2. Per-phase value must be an array -> 'non_array_per_phase'.
 *   3. Each array element must be a string -> 'non_string_element'.
 *   4. Each string element must be in VALID_SUBSTAGES -> 'out_of_enum'.
 *
 * The absent-field case (missing top-level `substages_visited` OR missing
 * per-phase key) is NOT malformed — it returns `{ malformed: false }`.
 *
 * @param {*} substagesVisited - Raw session.substages_visited field
 * @param {string} gatePhase - Target phase (used for per-phase key lookup)
 * @returns {{ malformed: boolean, reason: string|null, observedType: string|null, observedValue: string|null }}
 */
function inspectSubstagesVisitedShape(substagesVisited, gatePhase) {
  // Case A: field absent entirely -> not malformed, caller handles as empty.
  if (substagesVisited === undefined) {
    return { malformed: false, reason: null, observedType: null, observedValue: null };
  }

  // Layer 1: top-level must be a plain object (not null, not array)
  if (
    substagesVisited === null ||
    typeof substagesVisited !== 'object' ||
    Array.isArray(substagesVisited)
  ) {
    return {
      malformed: true,
      reason: 'non_object_top',
      observedType: classifyObservedType(substagesVisited),
      observedValue: truncateObservedValue(substagesVisited),
    };
  }

  // Look up per-phase value. The per-phase key is the PHASE of the substage,
  // which for challenger sub-stages is 'challenging'. We use 'challenging' as
  // the fixed per-phase key (the only phase that carries substages today).
  // EC-C10: future extension keys are independent; absent per-phase key is
  // NOT malformed.
  const perPhaseKey = 'challenging';
  const perPhaseValue = substagesVisited[perPhaseKey];

  // Case B: per-phase key absent -> not malformed, caller handles as empty.
  if (perPhaseValue === undefined) {
    return { malformed: false, reason: null, observedType: null, observedValue: null };
  }

  // Layer 2: per-phase value must be an array
  if (!Array.isArray(perPhaseValue)) {
    return {
      malformed: true,
      reason: 'non_array_per_phase',
      observedType: classifyObservedType(perPhaseValue),
      observedValue: truncateObservedValue(perPhaseValue),
    };
  }

  // Layer 3: each element must be a string
  for (const elem of perPhaseValue) {
    if (typeof elem !== 'string') {
      return {
        malformed: true,
        reason: 'non_string_element',
        observedType: classifyObservedType(elem),
        observedValue: truncateObservedValue(perPhaseValue),
      };
    }
  }

  // Layer 4: each string must be in closed enum
  for (const elem of perPhaseValue) {
    if (!VALID_SUBSTAGES.includes(elem)) {
      return {
        malformed: true,
        reason: 'out_of_enum',
        observedType: 'string',
        observedValue: truncateObservedValue(perPhaseValue),
      };
    }
  }

  return { malformed: false, reason: null, observedType: null, observedValue: null };
}

/**
 * Check for pre-upgrade legacy bare-`challenging` history entries.
 *
 * A legacy entry is a session history record where
 *   event_type === 'phase_transition' AND details.to_phase === 'challenging'
 * with no corresponding post-upgrade substage attribution in
 * `substages_visited.challenging` (i.e., the history entry predates the
 * as-002c populate-path landing).
 *
 * Emits `dag.substage.legacy_visit_ignored {phase: 'challenging', session_id}`
 * once per encountered legacy entry during a single validation invocation
 * (Q-C4 locked decision: per encountered entry, not per call).
 *
 * Treats each legacy visit as a no-op for substage obligation purposes —
 * does NOT contribute to substages_visited.
 *
 * @param {object} session - Session object
 * @param {string} sessionIdHash - Hashed session identifier for log emission
 */
function emitLegacyChallengingVisitIgnored(session, sessionIdHash) {
  const history = Array.isArray(session?.history) ? session.history : [];
  if (history.length === 0) return;

  // Post-upgrade populate indicator: if substages_visited.challenging is a
  // non-empty array, the populate path has executed. Legacy entries from
  // BEFORE the populate path are still treated as legacy (Q-C4 / AC6.5 —
  // emit even when post-upgrade populate coexists, to preserve audit trail).
  // We therefore emit one line per history entry matching the legacy shape,
  // regardless of populate state.
  let legacyCount = 0;
  for (const entry of history) {
    if (
      entry &&
      entry.event_type === 'phase_transition' &&
      entry.details &&
      entry.details.to_phase === 'challenging'
    ) {
      // Heuristic: a history entry is legacy iff it does NOT carry a
      // `substage` attribution (populate-path-emitted entries carry substage
      // in details to distinguish). For backward compatibility, entries
      // without details.substage are treated as legacy.
      if (!entry.details.substage) {
        legacyCount += 1;
        emitSubstageLog('dag.substage.legacy_visit_ignored', {
          phase: 'challenging',
          session_id: sessionIdHash,
        });
      }
    }
  }
  return legacyCount;
}

/**
 * validateSubstages — obligation-check for challenger sub-stage presence.
 *
 * Pure function; READ-ONLY on session; no disk side-effect. Emits structured
 * log lines to stderr as a side-effect. Idempotent: same input yields same
 * output and same log emission.
 *
 * Spec: sg-workflow-convergence-bugs (ws-dag-substages)
 *   - as-003c: core evaluator (absent + happy-path + true-positive skip)
 *   - as-005c: malformed detection branches (4 variants)
 *   - as-006c: legacy bare-challenging visit ignore
 *
 * Return shape (frozen contract, behavioral):
 *   {
 *     passed: boolean,
 *     missing: string[],              // substage enum members; empty when passed
 *     malformed: boolean,
 *     malformed_reason: 'missing_field' | 'non_object_top' |
 *                       'non_array_per_phase' | 'non_string_element' |
 *                       'out_of_enum' | null
 *   }
 *
 * Exempt workflows (oneoff-vibe, refactor, journal-only) always return
 * `{passed: true, missing: [], malformed: false, malformed_reason: null}`
 * without emitting any log line.
 *
 * Fail-closed semantics:
 *   - Absent field: treat as empty set, block, emit dag.substage.skipped
 *     (NO dag.substage.malformed — absent is distinct).
 *   - Malformed: treat affected per-phase set as empty, block, emit
 *     dag.substage.malformed with closed-enum reason.
 *   - Legacy bare-challenging visit: emit dag.substage.legacy_visit_ignored
 *     per encountered history entry; the legacy visit does NOT contribute
 *     to substage presence.
 *
 * @param {string} targetPhase - VALID_PHASES member (the phase being transitioned TO)
 * @param {object} session - Parsed session.json object
 * @param {string} workflow - VALID_WORKFLOWS member
 * @returns {{ passed: boolean, missing: string[], malformed: boolean, malformed_reason: string|null }}
 */
export function validateSubstages(targetPhase, session, workflow) {
  // as-008 / REQ-007 / AC8.2: env-parity check at validator entry. This
  // validator already has the session object in-hand, so we call the guard
  // directly. Legacy sessions (no project_dir_pin) are skipped inside
  // enforceEnvParity — a no-op returns cleanly. Violations throw Error with
  // `code === 'WORKTREE_PATH_VIOLATION'`; the calling hook wrapper catches
  // and routes per AC8.2 (exit 2 + audit entry).
  enforceEnvParity(session);

  // Exempt workflows: passthrough (AC3.7)
  if (EXEMPT_WORKFLOWS.includes(workflow)) {
    return { passed: true, missing: [], malformed: false, malformed_reason: null };
  }

  // Resolve required substage for this (phase, workflow). No requirement ->
  // trivially passed (e.g., target is auto_approval or documenting).
  const requiredSubstage = getRequiredSubstageForPhase(targetPhase, workflow);
  if (!requiredSubstage) {
    return { passed: true, missing: [], malformed: false, malformed_reason: null };
  }

  const sessionIdHash = hashSessionIdForLog(session?.session_id);

  // Legacy bare-challenging visit detection (AC6.1..AC6.6 / as-006c).
  // Emits one dag.substage.legacy_visit_ignored per encountered legacy entry.
  // Runs BEFORE malformed/absent checks so the log emission cardinality is
  // not coupled to admission/block decisions. Safe-no-op when history is
  // absent or empty.
  emitLegacyChallengingVisitIgnored(session, sessionIdHash);

  // Malformed detection (AC5.1..AC5.7 / as-005c).
  const substagesVisited = session?.substages_visited;
  const shape = inspectSubstagesVisitedShape(substagesVisited, 'challenging');

  if (shape.malformed) {
    // Block, emit malformed log, return all-required-missing + reason.
    emitSubstageLog('dag.substage.malformed', {
      gate: targetPhase,
      observed_type: shape.observedType,
      observed_value: shape.observedValue,
      session_id: sessionIdHash,
    });
    // Per R-015: treat affected per-phase set as empty -> all required missing.
    // For the single-substage-per-phase case, missing list contains just the
    // one required substage (the shape failure blocks the whole gate per
    // AC-C7 "presence of non-required ... SHALL NOT substitute for missing").
    return {
      passed: false,
      missing: [requiredSubstage],
      malformed: true,
      malformed_reason: shape.reason,
    };
  }

  // Absent-field path (AC3.5 / AC-C6).
  // Either top-level field absent OR per-phase key absent -> empty set.
  if (substagesVisited === undefined) {
    emitSubstageLog('dag.substage.skipped', {
      phase: targetPhase,
      substage: requiredSubstage,
      session_id: sessionIdHash,
    });
    return {
      passed: false,
      missing: [requiredSubstage],
      malformed: false,
      malformed_reason: null,
    };
  }

  // Well-formed path: read visited set (empty if per-phase key absent).
  const visitedSet = Array.isArray(substagesVisited.challenging)
    ? substagesVisited.challenging
    : [];

  if (visitedSet.includes(requiredSubstage)) {
    // Happy path (AC3.1 / AC3.3 / AC3.4)
    return { passed: true, missing: [], malformed: false, malformed_reason: null };
  }

  // True-positive skip (AC3.2 / AC-C2): required missing, emit skip log, block.
  emitSubstageLog('dag.substage.skipped', {
    phase: targetPhase,
    substage: requiredSubstage,
    session_id: sessionIdHash,
  });
  // AC-C7 / AC-C2: `missing` reports the CUMULATIVE required substages up
  // to and including targetPhase that are not yet visited. For `testing`
  // target this spans {implementing, testing} required substages; for
  // `reviewing` target, all three phases. Non-required visited substages
  // (e.g., pre-impl in an orchestrator session) do NOT substitute for
  // the workflow-required set.
  const missingReport = computeCumulativeMissing(
    targetPhase, workflow, visitedSet
  );
  return {
    passed: false,
    missing: missingReport.length > 0 ? missingReport : [requiredSubstage],
    malformed: false,
    malformed_reason: null,
  };
}

/**
 * Compute the cumulative missing required substages for (targetPhase, workflow, visited).
 *
 * The cumulative set is the workflow-scoped required substages whose gate
 * phase (per PHASE_REQUIRED_SUBSTAGE) is targetPhase OR a phase that
 * precedes targetPhase in the challenger-gated chain
 * (implementing → testing → reviewing). A substage is "missing" iff it is
 * in the cumulative set AND not present in visited.
 *
 * @param {string} targetPhase
 * @param {string} workflow
 * @param {string[]} visited
 * @returns {string[]}
 */
function computeCumulativeMissing(targetPhase, workflow, visited) {
  const mapping = PHASE_REQUIRED_SUBSTAGE[workflow];
  if (!mapping) return [];
  // Chain order: implementing → testing → reviewing (phases that carry a
  // required challenger substage under both workflows).
  const CHAIN = ['implementing', 'testing', 'reviewing'];
  const targetIdx = CHAIN.indexOf(targetPhase);
  if (targetIdx < 0) {
    // Target is outside the substage chain (e.g., documenting). Fall back
    // to the single-substage for this target if any.
    const sub = mapping[targetPhase];
    return sub && !visited.includes(sub) ? [sub] : [];
  }
  const workflowSet = REQUIRED_SUBSTAGES_BY_WORKFLOW[workflow] || [];
  const missing = [];
  for (let i = 0; i <= targetIdx; i++) {
    const phase = CHAIN[i];
    const sub = mapping[phase];
    if (!sub) continue;
    // Only include substages that are in the workflow required set.
    if (!workflowSet.includes(sub)) continue;
    if (!visited.includes(sub) && !missing.includes(sub)) {
      missing.push(sub);
    }
  }
  return missing;
}

/**
 * Compute the full missing required set for (target phase, workflow, session).
 *
 * Helper for AC-C7 reporting where the caller wants ALL missing required
 * substages (not just the single target-phase-required substage).
 * `validateSubstages()` returns a single-element missing array because the
 * target phase's check is against ONE required substage; this helper inspects
 * the entire workflow-scoped required set and returns any missing.
 *
 * Used by workflow-gate-enforcement.mjs / workflow-stop-enforcement.mjs
 * (as-007c) for richer error messages on blocking failures.
 *
 * @param {object} session - Parsed session.json object
 * @param {string} workflow - VALID_WORKFLOWS member
 * @returns {string[]} Array of required substages not yet visited; empty when all present or workflow exempt
 */
export function getMissingRequiredSubstages(session, workflow) {
  if (EXEMPT_WORKFLOWS.includes(workflow)) return [];
  const required = REQUIRED_SUBSTAGES_BY_WORKFLOW[workflow] || [];
  if (required.length === 0) return [];
  const substagesVisited = session?.substages_visited;
  // Absent or malformed shape -> all required missing.
  if (
    !substagesVisited ||
    typeof substagesVisited !== 'object' ||
    Array.isArray(substagesVisited)
  ) {
    return [...required];
  }
  const visited = Array.isArray(substagesVisited.challenging)
    ? substagesVisited.challenging.filter(s => VALID_SUBSTAGES.includes(s))
    : [];
  return required.filter(r => !visited.includes(r));
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Get the workflow type from session state.
 * Returns the workflow from active_work, defaulting to 'orchestrator' if missing.
 * Backward-compatible -- used by session-checkpoint.mjs (cooperative layer).
 *
 * @param {object} session - Session object from session.json
 * @returns {string} Workflow type string
 */
export function getWorkflowType(session) {
  const workflow = session?.active_work?.workflow;
  if (!workflow) {
    return 'orchestrator';
  }
  return workflow;
}

/**
 * Get the workflow type from session state, strict mode.
 * Returns null if workflow is not set -- used by coercive hooks for fail-open behavior.
 *
 * @param {object} session - Session object from session.json
 * @returns {string|null} Workflow type string or null
 */
export function getWorkflowTypeStrict(session) {
  return session?.active_work?.workflow || null;
}

/**
 * Check if a workflow type is exempt from enforcement.
 *
 * @param {string} workflow - Workflow type string
 * @returns {boolean} True if exempt
 */
export function isExemptWorkflow(workflow) {
  return EXEMPT_WORKFLOWS.includes(workflow);
}

/**
 * Get the predecessor graph for a given workflow type.
 * Returns null for exempt workflows. Defaults to orchestrator when unknown.
 *
 * @param {string} workflow - Workflow type string
 * @returns {object|null} Predecessor graph or null for exempt workflows
 */
export function getPredecessorGraph(workflow) {
  if (EXEMPT_WORKFLOWS.includes(workflow)) return null;
  if (workflow === 'oneoff-spec') return ONEOFF_SPEC_PREDECESSORS;
  return ORCHESTRATOR_PREDECESSORS; // default to most restrictive
}

/**
 * Check if a parameterized predecessor was visited.
 * For "challenging:<stage>" keys, checks dispatch history for a challenger
 * subagent with the matching stage field. For plain phase names, checks
 * session history for a phase_transition event to that phase.
 *
 * @param {string} predecessorKey - Predecessor key (e.g., "challenging:pre-orchestration" or "spec_authoring")
 * @param {object} session - Session object from session.json
 * @returns {boolean} True if the predecessor was visited
 */
export function wasPredecessorVisited(predecessorKey, session) {
  const challengeMatch = predecessorKey.match(/^challenging:(.+)$/);

  if (challengeMatch) {
    const requiredStage = challengeMatch[1];
    // Check dispatch history for a challenger with this stage
    const allTasks = [
      ...(session.subagent_tasks?.in_flight || []),
      ...(session.subagent_tasks?.completed_this_session || [])
    ];
    return allTasks.some(
      t => t.subagent_type === 'challenger' && t.stage === requiredStage
    );
  }

  // Plain phase: check if it appears in session history as a phase_transition target
  return (session.history || []).some(
    h => h.event_type === 'phase_transition' && h.details?.to_phase === predecessorKey
  );
}

/**
 * Get all dispatch tasks from session (both in-flight and completed).
 *
 * @param {object} session - Session object from session.json
 * @returns {Array} Array of dispatch task records
 */
export function getAllTasks(session) {
  return [
    ...(session.subagent_tasks?.in_flight || []),
    ...(session.subagent_tasks?.completed_this_session || [])
  ];
}

/**
 * Get the prerequisites for a given subagent type in a given workflow.
 * Returns an array of prerequisite descriptors.
 *
 * Each prerequisite is one of:
 * - { type: 'dispatch', subagent_type: string } - a dispatch must exist
 * - { type: 'dispatch', subagent_type: string, stage: string } - a staged dispatch must exist
 * - { type: 'convergence', gate: string, required_count: number } - convergence count must be met
 *
 * @param {string} workflow - Workflow type ('oneoff-spec' or 'orchestrator')
 * @param {string} subagentType - The subagent type to check prerequisites for
 * @returns {Array<object>} Prerequisites array
 */
export function getPrerequisites(workflow, subagentType) {
  if (!ENFORCED_SUBAGENT_TYPES.includes(subagentType)) {
    return [];
  }

  const prerequisites = [];

  switch (subagentType) {
    case 'implementer': {
      // AC-1.7, AC-1.8: Convergence-type prerequisites for investigation and challenger
      prerequisites.push({
        type: 'convergence',
        gate: 'investigation',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.investigation_convergence,
      });
      prerequisites.push({
        type: 'convergence',
        gate: 'challenger',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.challenger_convergence,
      });
      break;
    }

    case 'test-writer': {
      // No coercive prerequisites — test-writer works from spec only (Practice 2.4)
      // Implementer dispatch ordering is a workflow convention, not a gate requirement
      break;
    }

    case 'e2e-test-writer': {
      // No coercive prerequisites — e2e-test-writer works from spec/contracts only (Practice 2.4)
      // Same dispatch pattern as test-writer: parallel with implementer, no ordering dependency
      break;
    }

    case 'code-reviewer': {
      // REQ-004 (as-024) — AC24.5: challenger pre-review dispatch deleted.
      // Only unifier dispatch remains as coercive prereq; reviewer-focus
      // signal is surfaced via dispatch-prompt metadata (see
      // reviewer-focus-metadata.mjs) rather than a blocking challenger pass.
      prerequisites.push({
        type: 'dispatch',
        subagent_type: 'unifier',
        gate_name: OVERRIDE_GATE_NAMES.unifier_dispatch,
      });
      break;
    }

    case 'security-reviewer': {
      // Same prerequisites as code-reviewer — both run in parallel after
      // review prerequisites. REQ-004 (as-024) removed the challenger
      // pre-review prereq; reviewer-focus metadata replaces that signal.
      prerequisites.push({
        type: 'dispatch',
        subagent_type: 'unifier',
        gate_name: OVERRIDE_GATE_NAMES.unifier_dispatch,
      });
      break;
    }

    case 'documenter': {
      // Requires BOTH review convergence gates — both run in parallel, both must converge
      prerequisites.push({
        type: 'convergence',
        gate: 'code_review',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.code_review_convergence,
      });
      prerequisites.push({
        type: 'convergence',
        gate: 'security_review',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.security_review_convergence,
      });
      break;
    }

    case 'completion-verifier': {
      // Requires BOTH review convergence gates — completion-verifier runs AFTER reviewing phase
      // DAG: reviewing -> completion_verifying -> documenting
      prerequisites.push({
        type: 'convergence',
        gate: 'code_review',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.code_review_convergence,
      });
      prerequisites.push({
        type: 'convergence',
        gate: 'security_review',
        required_count: REQUIRED_CLEAN_PASSES,
        gate_name: OVERRIDE_GATE_NAMES.security_review_convergence,
      });
      break;
    }
  }

  return prerequisites;
}

/**
 * Check whether prerequisites are met in session state.
 *
 * @param {object} session - Session object from session.json
 * @param {Array<object>} prerequisites - Prerequisites from getPrerequisites()
 * @returns {{ met: boolean, missing: Array<{ prerequisite: object, gate_name: string }> }}
 */
export function werePrerequisitesMet(session, prerequisites) {
  const missing = [];
  const allTasks = getAllTasks(session);

  for (const prereq of prerequisites) {
    if (prereq.type === 'dispatch') {
      let found;
      if (prereq.stage) {
        found = allTasks.some(
          t => t.subagent_type === prereq.subagent_type && t.stage === prereq.stage
        );
      } else {
        found = allTasks.some(
          t => t.subagent_type === prereq.subagent_type
        );
      }

      if (!found) {
        missing.push({
          prerequisite: prereq,
          gate_name: prereq.gate_name,
        });
      }
    } else if (prereq.type === 'convergence') {
      // Fail-CLOSED: missing convergence field treated as 0 (REQ-031)
      const count = session.convergence?.[prereq.gate]?.clean_pass_count ?? 0;
      if (count < prereq.required_count) {
        missing.push({
          prerequisite: prereq,
          gate_name: prereq.gate_name,
        });
      }
    }
  }

  return {
    met: missing.length === 0,
    missing,
  };
}
