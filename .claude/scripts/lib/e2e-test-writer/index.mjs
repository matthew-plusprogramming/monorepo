/**
 * e2e-test-writer runtime connectivity authoring library.
 *
 * Reifies the archetype selection, placeholder substitution, scaffold-tier
 * resolution, and host-discovery helpers that the `e2e-test-writer` agent
 * invokes when emitting the canonical runtime connectivity smoke test.
 *
 * Consumers: the agent's in-process authoring pipeline and the unit/contract
 * tests under `.claude/scripts/__tests__/e2e-test-writer/`. The agent dispatch
 * itself remains declarative markdown at `.claude/agents/e2e-test-writer.md`;
 * this library is the unit-testable shadow of that authoring contract.
 *
 * Ownership: `contract-archetype-templates` runtime-connectivity contract.
 *
 * @module e2e-test-writer
 * @contract runtime-connectivity-authoring
 * @req REQ-F-001, REQ-F-001a, REQ-F-003, REQ-F-008, REQ-NFR-006, REQ-NFR-013
 */

export {
  ARCHETYPES,
  ARCHETYPE_SELECTION_AMBIGUOUS,
  ARCHETYPE_SELECTION_NO_MATCH,
  selectArchetype,
} from './archetype-selection.mjs';

export {
  CANONICAL_PLACEHOLDERS,
  ARCHETYPE_SPECIFIC_PLACEHOLDERS,
  PLACEHOLDER_GRAMMAR,
  buildSubstitutionMap,
  substitute,
  UnresolvedPlaceholderError,
} from './substitution.mjs';

export {
  LIVENESS_TIERS,
  resolveProvisioningBlock,
  InvalidLivenessError,
} from './scaffold-tier.mjs';

export {
  resolveHostDiscovery,
  InvalidPreferIpv6Error,
} from './host-discovery.mjs';

export {
  loadTemplate,
  TemplateNotFoundError,
} from './template-loader.mjs';

export {
  emitRuntimeConnectivityTest,
  EmissionError,
} from './emit.mjs';
