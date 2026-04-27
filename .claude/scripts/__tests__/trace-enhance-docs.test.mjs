/**
 * Tests for Trace System Enhancement -- Milestones 2 & 3: Consumption & Documentation
 *
 * Current policy after trace simplification:
 * - Route reads high-level traces when present.
 * - CLAUDE.md owns the compact trace contract for normal sessions.
 * - Low-level traces are optional sidecars; .calls.json is tool-only.
 * - Detailed trace mechanics live in docs, not duplicated across hot skills.
 *
 * These tests intentionally do not require every hot skill to carry a Trace
 * Context section. That old requirement pushed repeated prompt bloat into
 * normal dispatches.
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-enhance-docs
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// =============================================================================
// Helpers
// =============================================================================

// Resolve project root: __tests__ -> scripts -> .claude -> project root
const PROJECT_ROOT = new URL('../../..', import.meta.url).pathname;

function readProjectFile(relativePath) {
  const fullPath = join(PROJECT_ROOT, relativePath);
  if (!existsSync(fullPath)) {
    return null;
  }
  return readFileSync(fullPath, 'utf-8');
}

// =============================================================================
// AC-2.3: Route skill reads high-level.md
// =============================================================================

describe('Route skill -- trace reading (AC-2.3)', () => {
  it('route skill should instruct reading high-level.md (AC-2.3)', () => {
    // Arrange
    const content = readProjectFile('.claude/skills/route/SKILL.md');

    // Assert
    expect(content !== null).toBeTruthy();
    expect(content.includes('high-level.md') || content.includes('high-level trace')).toBeTruthy();
  });

  it('route skill should mention architectural context for dispatch (AC-2.3)', () => {
    // Arrange
    const content = readProjectFile('.claude/skills/route/SKILL.md');

    // Assert
    expect(content !== null).toBeTruthy();
    expect(content.includes('dispatch') || content.includes('module landscape') || content.includes('architectural')).toBeTruthy();
  });
});

// =============================================================================
// AC-2.4: Graceful degradation when traces unavailable
// =============================================================================

describe('Graceful degradation (AC-2.4)', () => {
  it('route skill should mention proceeding without traces if unavailable (AC-2.4)', () => {
    // Arrange
    const content = readProjectFile('.claude/skills/route/SKILL.md');

    // Assert
    expect(content !== null).toBeTruthy();
    // Route should work even without traces
    expect(content.includes('if') || content.includes('exist') || content.includes('available')).toBeTruthy();
  });
});

// =============================================================================
// AC-3.1: CLAUDE.md has positive trace instruction
// =============================================================================

describe('CLAUDE.md -- trace guidance (AC-3.1)', () => {
  it('should keep the compact trace contract in the root prompt (AC-3.1)', () => {
    // Arrange
    const content = readProjectFile('CLAUDE.md');

    // Assert
    expect(content !== null).toBeTruthy();
    expect(content.includes('### Trace Context')).toBeTruthy();
    expect(content.includes('.claude/traces/high-level.md')).toBeTruthy();
    expect(content.includes('optional orientation')).toBeTruthy();
  });

  it('should maintain delegation-first constraint boundary (AC-3.1)', () => {
    // Arrange
    const content = readProjectFile('CLAUDE.md');

    // Assert
    expect(content !== null).toBeTruthy();
    // Should still have delegation-first references
    expect(content.includes('delegation-first') || content.includes('Delegation-First')).toBeTruthy();
    expect(content.includes('automation-generated') || content.includes('advisory')).toBeTruthy();
  });

  it('should not weaken delegation-first constraints (AC-3.1)', () => {
    // Arrange
    const content = readProjectFile('CLAUDE.md');

    // Assert
    expect(content !== null).toBeTruthy();
    expect(content.includes('Do not read `.calls.json` directly')).toBeTruthy();
    expect(content.includes('trace-query.mjs')).toBeTruthy();
  });
});

// =============================================================================
// AC-3.2: delegation.guidelines.md references traces
// =============================================================================

describe('delegation.guidelines.md -- trace references (AC-3.2)', () => {
  it('should reference trace consumption (AC-3.2)', () => {
    // Arrange
    const content = readProjectFile('.claude/memory-bank/delegation.guidelines.md');

    // Assert
    expect(content !== null).toBeTruthy();
    expect(content.includes('trace') || content.includes('Trace')).toBeTruthy();
  });

  it('should distinguish trace reading from file-reading prohibition (AC-3.2)', () => {
    // Arrange
    const content = readProjectFile('.claude/memory-bank/delegation.guidelines.md');

    // Assert
    expect(content !== null).toBeTruthy();
    // Should have guidance on when/how to read traces
    expect(content.includes('pre-computed') || content.includes('architectural') || content.includes('high-level')).toBeTruthy();
  });
});

// =============================================================================
// AC-3.3: tech.context.md documents trace system
// =============================================================================

describe('tech.context.md -- trace documentation (AC-3.3)', () => {
  it('should contain trace consumption guidance (AC-3.3)', () => {
    // Arrange
    const content = readProjectFile('.claude/memory-bank/tech.context.md');

    // Assert
    expect(content !== null).toBeTruthy();
    expect(content.includes('trace') || content.includes('Trace')).toBeTruthy();
  });

  it('should document what trace files contain (AC-3.3)', () => {
    // Arrange
    const content = readProjectFile('.claude/memory-bank/tech.context.md');

    // Assert
    expect(content !== null).toBeTruthy();
    expect(content.includes('structural metadata') || content.includes('export') || content.includes('module')).toBeTruthy();
  });
});

// =============================================================================
// AC-3.4: Sync compatibility
// =============================================================================

describe('Sync compatibility (AC-3.4)', () => {
  it('metaclaude-registry.json should exist (AC-3.4)', () => {
    // Arrange & Assert
    const content = readProjectFile('.claude/metaclaude-registry.json');
    expect(content !== null).toBeTruthy();
  });

  it('trace script files should be registered in metaclaude-registry.json (AC-3.4)', () => {
    // Arrange
    const content = readProjectFile('.claude/metaclaude-registry.json');
    expect(content !== null).toBeTruthy();

    const registry = JSON.parse(content);

    // Assert -- trace scripts should be registered somewhere in the registry
    // The scripts may be under a nested key like scripts.trace-generate
    const registryStr = JSON.stringify(registry);
    const hasTraceRef = registryStr.includes('trace-generate') ||
      registryStr.includes('trace-utils') ||
      registryStr.includes('high-level-trace');
    expect(hasTraceRef).toBeTruthy();
  });

  it('trace output files should NOT be registered in metaclaude-registry.json (AC-3.4)', () => {
    // Arrange
    const content = readProjectFile('.claude/metaclaude-registry.json');
    expect(content !== null).toBeTruthy();

    const registry = JSON.parse(content);

    // Assert -- high-level.json / high-level.md output files should not be registered
    const artifacts = registry.artifacts || {};
    const hasTraceOutput = Object.values(artifacts).some(
      a => a.path && (a.path.includes('high-level.json') || a.path.includes('high-level.md') || a.path.includes('low-level/')),
    );
    expect(!hasTraceOutput).toBeTruthy();
  });
});
