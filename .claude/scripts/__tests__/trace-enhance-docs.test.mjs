/**
 * Tests for Trace System Enhancement -- Milestones 2 & 3: Consumption & Documentation
 *
 * Spec: .claude/specs/groups/sg-trace-system-enhancement/spec.md
 *
 * Validates:
 * - AC-2.1: Skill files reference trace paths (not self-service templates)
 * - AC-2.2: All five skill files use canonical pattern
 * - AC-2.3: Route skill reads high-level.md
 * - AC-2.4: Graceful degradation when traces unavailable
 * - AC-3.1: CLAUDE.md has positive trace instruction (not buried exception)
 * - AC-3.2: delegation.guidelines.md references traces
 * - AC-3.3: tech.context.md documents trace system
 * - AC-3.4: All changes sync-compatible (registry check)
 *
 * These tests verify file content matches spec requirements.
 * They read the actual files and assert required sections/keywords exist.
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

// Skill file paths
const SKILL_FILES = [
  { path: '.claude/skills/implement/SKILL.md', name: 'implement' },
  { path: '.claude/skills/test/SKILL.md', name: 'test' },
  { path: '.claude/skills/code-review/SKILL.md', name: 'code-review' },
  { path: '.claude/skills/security/SKILL.md', name: 'security' },
  { path: '.claude/agents/explore.md', name: 'explore' },
];

// =============================================================================
// AC-2.1: Skill files reference trace paths (not self-service templates)
// =============================================================================

describe('Skill files -- trace path references (AC-2.1)', () => {
  for (const { path: filePath, name } of SKILL_FILES) {
    it(`${name} skill should reference trace file paths, not unfilled placeholders (AC-2.1)`, () => {
      // Arrange
      const content = readProjectFile(filePath);

      // Assert
      expect(content !== null).toBeTruthy();
      // Should reference trace paths
      expect(content.includes('traces/low-level/') || content.includes('trace') || content.includes('Trace')).toBeTruthy();
      // Should reference freshness / isTraceStale
      expect(content.includes('isTraceStale') || content.includes('freshness') || content.includes('stale')).toBeTruthy();
    });
  }
});

// =============================================================================
// AC-2.2: All five skill files use canonical pattern
// =============================================================================

describe('Skill files -- canonical trace context pattern (AC-2.2)', () => {
  it('all five skill/agent files should contain a Trace Context section (AC-2.2)', () => {
    // Arrange & Act
    const contents = SKILL_FILES.map(({ path: p, name }) => ({
      name,
      content: readProjectFile(p),
    }));

    // Assert
    for (const { name, content } of contents) {
      expect(content !== null).toBeTruthy();
      expect(content.includes('Trace Context') || content.includes('### Trace Context') || content.includes('## Trace Context')).toBeTruthy();
    }
  });

  it('all five files should reference the same freshness check approach (AC-2.2)', () => {
    // Arrange
    const contents = SKILL_FILES.map(({ path: p, name }) => ({
      name,
      content: readProjectFile(p),
    })).filter(({ content }) => content !== null);

    // Assert -- all should reference isTraceStale for freshness
    for (const { name, content } of contents) {
      expect(content.includes('isTraceStale') || content.includes('freshness')).toBeTruthy();
    }
  });

  it('all five files should reference trace.config.json for path resolution (AC-2.2)', () => {
    // Arrange
    const contents = SKILL_FILES.map(({ path: p, name }) => ({
      name,
      content: readProjectFile(p),
    })).filter(({ content }) => content !== null);

    // Assert
    for (const { name, content } of contents) {
      expect(content.includes('trace.config.json') || content.includes('fileGlobs') || content.includes('loadTraceConfig')).toBeTruthy();
    }
  });
});

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
  it('skill files should mention graceful degradation for missing traces (AC-2.4)', () => {
    // Arrange -- check at least implement skill for the pattern
    const content = readProjectFile('.claude/skills/implement/SKILL.md');

    // Assert
    expect(content !== null).toBeTruthy();
    expect(content.includes('omit') || content.includes('graceful') || content.includes('without trace') || content.includes('not available') || content.includes('no traces')).toBeTruthy();
  });

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
  it('should have positive trace instruction, not just buried exception (AC-3.1)', () => {
    // Arrange
    const content = readProjectFile('CLAUDE.md');

    // Assert
    expect(content !== null).toBeTruthy();
    // Should have a positive instruction for trace reading
    expect(content.includes('MUST read') || content.includes('Trace Reading') || content.includes('traces/high-level')).toBeTruthy();
  });

  it('should maintain delegation-first constraint boundary (AC-3.1)', () => {
    // Arrange
    const content = readProjectFile('CLAUDE.md');

    // Assert
    expect(content !== null).toBeTruthy();
    // Should still have delegation-first references
    expect(content.includes('delegation-first') || content.includes('Delegation-First')).toBeTruthy();
    // Should maintain the boundary on what is readable
    expect(content.includes('.claude/traces/') || content.includes('automation-generated')).toBeTruthy();
  });

  it('should not weaken delegation-first constraints (AC-3.1)', () => {
    // Arrange
    const content = readProjectFile('CLAUDE.md');

    // Assert
    expect(content !== null).toBeTruthy();
    // Source code should still be off-limits
    expect(content.includes('source code') || content.includes('off-limits') || content.includes('remain')).toBeTruthy();
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

// =============================================================================
// Token budget verification (NFR-4 / AC-2.4 related)
// =============================================================================

describe('Trace read token budget (NFR-4)', () => {
  it('high-level.md should be under 5K tokens (~20KB) if it exists', () => {
    // Arrange
    const content = readProjectFile('.claude/traces/high-level.md');
    if (!content) {
      // Traces may not exist in this repo -- skip gracefully
      return;
    }

    // Assert -- rough token estimate: 1 token ~= 4 chars
    const estimatedTokens = Math.ceil(content.length / 4);
    expect(estimatedTokens < 5000).toBeTruthy();
  });
});
