/**
 * Tests for workflow-dag.mjs e2e-test-writer registration
 *
 * Spec: sg-e2e-testing
 * Covers: AC-12.1, AC-12.2, AC-12.3, AC-12.4
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs e2e-workflow-dag
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MODULE_PATH = join(__dirname, '..', 'lib', 'workflow-dag.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dynamically import the workflow-dag module.
 * Returns null if the module cannot be loaded.
 */
async function loadModule() {
  try {
    const url = new URL(`file://${MODULE_PATH}`);
    return await import(url.href);
  } catch {
    return null;
  }
}

// ============================================================================
// AC-12.1: e2e-test-writer in VALID_SUBAGENT_TYPES
// ============================================================================

describe('AC-12.1: VALID_SUBAGENT_TYPES includes e2e-test-writer', () => {
  it('should include e2e-test-writer in VALID_SUBAGENT_TYPES array (AC-12.1)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { VALID_SUBAGENT_TYPES } = mod;

    // Assert
    expect(Array.isArray(VALID_SUBAGENT_TYPES)).toBe(true);
    expect(VALID_SUBAGENT_TYPES).toContain('e2e-test-writer');
  });

  it('should have 22 entries in VALID_SUBAGENT_TYPES (20 existing + e2e-test-writer + flow-verifier) (AC-12.1)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { VALID_SUBAGENT_TYPES } = mod;

    // Assert
    expect(VALID_SUBAGENT_TYPES.length).toBe(22);
  });
});

// ============================================================================
// AC-12.2: e2e-test-writer in ENFORCED_SUBAGENT_TYPES
// ============================================================================

describe('AC-12.2: ENFORCED_SUBAGENT_TYPES includes e2e-test-writer', () => {
  it('should include e2e-test-writer in ENFORCED_SUBAGENT_TYPES array (AC-12.2)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { ENFORCED_SUBAGENT_TYPES } = mod;

    // Assert
    expect(Array.isArray(ENFORCED_SUBAGENT_TYPES)).toBe(true);
    expect(ENFORCED_SUBAGENT_TYPES).toContain('e2e-test-writer');
  });
});

// ============================================================================
// AC-12.3: getPrerequisites returns empty for e2e-test-writer
// ============================================================================

describe('AC-12.3: getPrerequisites returns empty prerequisites for e2e-test-writer', () => {
  it('should return empty prerequisites for e2e-test-writer in oneoff-spec workflow (AC-12.3)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const { getPrerequisites } = mod;

    // Act
    const prereqs = getPrerequisites('oneoff-spec', 'e2e-test-writer');

    // Assert
    expect(Array.isArray(prereqs)).toBe(true);
    expect(prereqs.length).toBe(0);
  });

  it('should return empty prerequisites for e2e-test-writer in orchestrator workflow (AC-12.3)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const { getPrerequisites } = mod;

    // Act
    const prereqs = getPrerequisites('orchestrator', 'e2e-test-writer');

    // Assert
    expect(Array.isArray(prereqs)).toBe(true);
    expect(prereqs.length).toBe(0);
  });

  it('should have same prerequisites as test-writer (both empty) (AC-12.3)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    const { getPrerequisites } = mod;

    // Act
    const e2ePrereqs = getPrerequisites('oneoff-spec', 'e2e-test-writer');
    const testPrereqs = getPrerequisites('oneoff-spec', 'test-writer');

    // Assert -- both should have empty prerequisites
    expect(e2ePrereqs.length).toBe(testPrereqs.length);
  });
});

// ============================================================================
// AC-12.4 (INVERTED per sg-e2e-default-dispatch AC-10.1):
// e2e-test-writer IS in STOP_MANDATORY_DISPATCHES
// ============================================================================

describe('AC-10.1: STOP_MANDATORY_DISPATCHES DOES include e2e-test-writer', () => {
  it('should include e2e-test-writer in STOP_MANDATORY_DISPATCHES (AC-10.1)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { STOP_MANDATORY_DISPATCHES } = mod;

    // Assert
    expect(Array.isArray(STOP_MANDATORY_DISPATCHES)).toBe(true);
    expect(STOP_MANDATORY_DISPATCHES).toContain('e2e-test-writer');
  });

  it('should have 5 entries in STOP_MANDATORY_DISPATCHES (4 existing + e2e-test-writer)', async () => {
    // Arrange
    const mod = await loadModule();
    expect(mod).not.toBeNull();

    // Act
    const { STOP_MANDATORY_DISPATCHES } = mod;

    // Assert
    expect(STOP_MANDATORY_DISPATCHES.length).toBe(5);
  });
});

// ============================================================================
// AC-1.1b: e2e-test-writer in STOP_PHASE_REQUIREMENTS
// ============================================================================

describe('AC-1.1b: STOP_PHASE_REQUIREMENTS includes e2e-test-writer in all four phases', () => {
  it('should include e2e-test-writer in reviewing phase', async () => {
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    expect(mod.STOP_PHASE_REQUIREMENTS.reviewing).toContain('e2e-test-writer');
  });

  it('should include e2e-test-writer in completion_verifying phase', async () => {
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    expect(mod.STOP_PHASE_REQUIREMENTS.completion_verifying).toContain('e2e-test-writer');
  });

  it('should include e2e-test-writer in documenting phase', async () => {
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    expect(mod.STOP_PHASE_REQUIREMENTS.documenting).toContain('e2e-test-writer');
  });

  it('should include e2e-test-writer in complete phase', async () => {
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    expect(mod.STOP_PHASE_REQUIREMENTS.complete).toContain('e2e-test-writer');
  });
});

// ============================================================================
// AC-3.2: VALID_E2E_SKIP_RATIONALES exported
// ============================================================================

describe('AC-3.2: VALID_E2E_SKIP_RATIONALES exported from workflow-dag', () => {
  it('should export VALID_E2E_SKIP_RATIONALES with 4 valid rationale values', async () => {
    const mod = await loadModule();
    expect(mod).not.toBeNull();
    expect(Array.isArray(mod.VALID_E2E_SKIP_RATIONALES)).toBe(true);
    expect(mod.VALID_E2E_SKIP_RATIONALES).toEqual([
      'pure-refactor',
      'test-infra',
      'type-only',
      'docs-only',
    ]);
  });
});
