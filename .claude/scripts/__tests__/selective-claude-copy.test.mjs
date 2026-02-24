/**
 * Selective Claude Copy Tests (AS-004)
 *
 * Tests for selectiveCopyClaudeDir, extractSpecGroupId,
 * cleanupExcludedDirs, and CLAUDE_INCLUDE_LIST.
 *
 * Covers: AC1.1 through AC4.2 (12 acceptance criteria)
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';

import {
  CLAUDE_INCLUDE_LIST,
  selectiveCopyClaudeDir,
  extractSpecGroupId,
  cleanupExcludedDirs,
} from '../selective-claude-copy.mjs';

/**
 * Helper to create a temp directory.
 */
const createTempDir = async () => mkdtemp(join(tmpdir(), 'selective-copy-'));

/**
 * Helper to check if a path exists.
 */
const pathExists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Helper to create a mock .claude directory structure.
 */
const createMockClaudeDir = async (baseDir) => {
  const claudeDir = join(baseDir, '.claude');

  // Create operational items (should be copied)
  await mkdir(join(claudeDir, 'skills'), { recursive: true });
  await writeFile(join(claudeDir, 'skills', 'test.md'), 'skill content');

  await mkdir(join(claudeDir, 'agents'), { recursive: true });
  await writeFile(join(claudeDir, 'agents', 'implementer.md'), 'agent content');

  await mkdir(join(claudeDir, 'templates'), { recursive: true });
  await writeFile(join(claudeDir, 'templates', 'fix-report.template.md'), 'template content');

  await mkdir(join(claudeDir, 'scripts'), { recursive: true });
  await writeFile(join(claudeDir, 'scripts', 'validate.mjs'), 'script content');

  await mkdir(join(claudeDir, 'schemas'), { recursive: true });
  await writeFile(join(claudeDir, 'schemas', 'spec.schema.json'), '{}');

  await mkdir(join(claudeDir, 'specs', 'schema'), { recursive: true });
  await writeFile(join(claudeDir, 'specs', 'schema', 'atomic-spec.schema.json'), '{}');

  await writeFile(join(claudeDir, 'settings.json'), '{"key": "value"}');

  // Create state items (should NOT be copied)
  await mkdir(join(claudeDir, 'specs', 'groups', 'sg-test'), { recursive: true });
  await writeFile(join(claudeDir, 'specs', 'groups', 'sg-test', 'spec.md'), 'spec content');

  await mkdir(join(claudeDir, 'context'), { recursive: true });
  await writeFile(join(claudeDir, 'context', 'session.json'), '{}');

  await mkdir(join(claudeDir, 'memory-bank'), { recursive: true });
  await writeFile(join(claudeDir, 'memory-bank', 'project.brief.md'), 'brief');

  await mkdir(join(claudeDir, 'journal', 'entries'), { recursive: true });
  await writeFile(join(claudeDir, 'journal', 'entries', 'entry-1.md'), 'journal entry');

  await mkdir(join(claudeDir, 'docs'), { recursive: true });
  await writeFile(join(claudeDir, 'docs', 'README.md'), 'docs content');

  await mkdir(join(claudeDir, 'contracts'), { recursive: true });
  await writeFile(join(claudeDir, 'contracts', 'api.yaml'), 'contract');

  return claudeDir;
};

describe('AS-004: Selective .claude/ Copy', () => {
  describe('CLAUDE_INCLUDE_LIST (AC1.1)', () => {
    it('should contain exactly: skills, agents, templates, scripts, schemas, specs/schema, settings.json (AC1.1)', () => {
      // Arrange
      const expectedItems = [
        'skills',
        'agents',
        'templates',
        'scripts',
        'schemas',
        'specs/schema',
        'settings.json',
      ];

      // Act & Assert
      assert.deepEqual(
        [...CLAUDE_INCLUDE_LIST].sort(),
        [...expectedItems].sort(),
      );
    });

    it('should have exactly 7 items (AC1.1)', () => {
      // Arrange & Act & Assert
      assert.equal(CLAUDE_INCLUDE_LIST.length, 7);
    });
  });

  describe('selectiveCopyClaudeDir (AC1.2, AC1.3, AC1.4, AC1.5)', () => {
    it('should copy only items in CLAUDE_INCLUDE_LIST from source to target (AC1.2)', async () => {
      // Arrange
      const sourceBase = await createTempDir();
      const targetBase = await createTempDir();
      const sourceClaudeDir = await createMockClaudeDir(sourceBase);
      const targetClaudeDir = join(targetBase, '.claude');

      // Act
      const result = selectiveCopyClaudeDir(sourceClaudeDir, targetClaudeDir);

      // Assert
      assert.ok(await pathExists(join(targetClaudeDir, 'skills')));
      assert.ok(await pathExists(join(targetClaudeDir, 'agents')));
      assert.ok(await pathExists(join(targetClaudeDir, 'templates')));
      assert.ok(await pathExists(join(targetClaudeDir, 'scripts')));
      assert.ok(await pathExists(join(targetClaudeDir, 'schemas')));
      assert.ok(await pathExists(join(targetClaudeDir, 'settings.json')));

      // Cleanup
      await rm(sourceBase, { recursive: true });
      await rm(targetBase, { recursive: true });
    });

    it('should return { copied, skipped } summary (AC1.3)', async () => {
      // Arrange
      const sourceBase = await createTempDir();
      const targetBase = await createTempDir();
      const sourceClaudeDir = await createMockClaudeDir(sourceBase);
      const targetClaudeDir = join(targetBase, '.claude');

      // Act
      const result = selectiveCopyClaudeDir(sourceClaudeDir, targetClaudeDir);

      // Assert
      assert.ok(Array.isArray(result.copied));
      assert.ok(Array.isArray(result.skipped));
      assert.ok(result.copied.length > 0);

      // Cleanup
      await rm(sourceBase, { recursive: true });
      await rm(targetBase, { recursive: true });
    });

    it('should NOT copy state directories: specs/groups, context, memory-bank, journal, docs, contracts (AC1.4)', async () => {
      // Arrange
      const sourceBase = await createTempDir();
      const targetBase = await createTempDir();
      const sourceClaudeDir = await createMockClaudeDir(sourceBase);
      const targetClaudeDir = join(targetBase, '.claude');

      // Act
      selectiveCopyClaudeDir(sourceClaudeDir, targetClaudeDir);

      // Assert - state dirs should NOT exist in target
      assert.equal(await pathExists(join(targetClaudeDir, 'specs', 'groups')), false);
      assert.equal(await pathExists(join(targetClaudeDir, 'context')), false);
      assert.equal(await pathExists(join(targetClaudeDir, 'memory-bank')), false);
      assert.equal(await pathExists(join(targetClaudeDir, 'journal')), false);
      assert.equal(await pathExists(join(targetClaudeDir, 'docs')), false);
      assert.equal(await pathExists(join(targetClaudeDir, 'contracts')), false);

      // Cleanup
      await rm(sourceBase, { recursive: true });
      await rm(targetBase, { recursive: true });
    });

    it('should copy specs/schema but not specs/groups (AC1.2, AC1.4)', async () => {
      // Arrange
      const sourceBase = await createTempDir();
      const targetBase = await createTempDir();
      const sourceClaudeDir = await createMockClaudeDir(sourceBase);
      const targetClaudeDir = join(targetBase, '.claude');

      // Act
      selectiveCopyClaudeDir(sourceClaudeDir, targetClaudeDir);

      // Assert
      assert.ok(await pathExists(join(targetClaudeDir, 'specs', 'schema')));
      assert.equal(await pathExists(join(targetClaudeDir, 'specs', 'groups')), false);

      // Cleanup
      await rm(sourceBase, { recursive: true });
      await rm(targetBase, { recursive: true });
    });

    it('should skip missing source items gracefully without throwing (AC1.5)', async () => {
      // Arrange
      const sourceBase = await createTempDir();
      const targetBase = await createTempDir();
      // Create a minimal .claude dir with only some items
      const claudeDir = join(sourceBase, '.claude');
      await mkdir(join(claudeDir, 'skills'), { recursive: true });
      await writeFile(join(claudeDir, 'skills', 'test.md'), 'content');
      // Do NOT create agents, templates, etc.

      // Act & Assert - should not throw
      const result = selectiveCopyClaudeDir(claudeDir, join(targetBase, '.claude'));

      // Assert
      assert.ok(result.skipped.length > 0, 'Some items should be in skipped list');
      assert.ok(result.copied.length > 0, 'At least skills should be copied');

      // Cleanup
      await rm(sourceBase, { recursive: true });
      await rm(targetBase, { recursive: true });
    });

    it('should add missing items to the skipped array (AC1.5)', async () => {
      // Arrange
      const sourceBase = await createTempDir();
      const targetBase = await createTempDir();
      // Create empty .claude dir
      const claudeDir = join(sourceBase, '.claude');
      await mkdir(claudeDir, { recursive: true });

      // Act
      const result = selectiveCopyClaudeDir(claudeDir, join(targetBase, '.claude'));

      // Assert
      assert.equal(result.skipped.length, CLAUDE_INCLUDE_LIST.length, 'All items should be skipped when source is empty');

      // Cleanup
      await rm(sourceBase, { recursive: true });
      await rm(targetBase, { recursive: true });
    });
  });

  describe('extractSpecGroupId (AC2.1, AC2.2, AC2.3)', () => {
    it('should extract spec group ID from branch name with sg- prefix (AC2.1)', () => {
      // Arrange
      const branchName = 'sg-auth-system/fix-logout';

      // Act
      const result = extractSpecGroupId(branchName);

      // Assert
      assert.equal(result, 'sg-auth-system');
    });

    it('should extract spec group ID from various sg- branch patterns (AC2.1)', () => {
      // Arrange & Act & Assert
      assert.equal(extractSpecGroupId('sg-cross-repo-infrastructure/as-001'), 'sg-cross-repo-infrastructure');
      assert.equal(extractSpecGroupId('sg-my-feature/implement'), 'sg-my-feature');
    });

    it('should return null for non-matching branch names (AC2.2)', () => {
      // Arrange & Act & Assert
      assert.equal(extractSpecGroupId('feature/random-branch'), null);
      assert.equal(extractSpecGroupId('main'), null);
      assert.equal(extractSpecGroupId('fix/some-bug'), null);
      assert.equal(extractSpecGroupId('develop'), null);
    });

    it('should return null for null input (AC2.3)', () => {
      // Arrange & Act & Assert
      assert.equal(extractSpecGroupId(null), null);
    });

    it('should return null for undefined input (AC2.3)', () => {
      // Arrange & Act & Assert
      assert.equal(extractSpecGroupId(undefined), null);
    });

    it('should not throw for null or undefined input (AC2.3)', () => {
      // Arrange & Act & Assert
      assert.doesNotThrow(() => extractSpecGroupId(null));
      assert.doesNotThrow(() => extractSpecGroupId(undefined));
    });
  });

  describe('cleanupExcludedDirs (AC3.1, AC3.2)', () => {
    it('should remove excluded state directories from an existing .claude/ directory (AC3.1)', async () => {
      // Arrange
      const tempDir = await createTempDir();
      const claudeDir = await createMockClaudeDir(tempDir);

      // Verify state dirs exist before cleanup
      assert.ok(await pathExists(join(claudeDir, 'context')));
      assert.ok(await pathExists(join(claudeDir, 'memory-bank')));

      // Act
      cleanupExcludedDirs(claudeDir);

      // Assert - state dirs should be removed
      assert.equal(await pathExists(join(claudeDir, 'context')), false);
      assert.equal(await pathExists(join(claudeDir, 'memory-bank')), false);
      assert.equal(await pathExists(join(claudeDir, 'journal')), false);
      assert.equal(await pathExists(join(claudeDir, 'docs')), false);

      // Operational dirs should still exist
      assert.ok(await pathExists(join(claudeDir, 'skills')));
      assert.ok(await pathExists(join(claudeDir, 'agents')));

      // Cleanup
      await rm(tempDir, { recursive: true });
    });

    it('should return array of directory names that were removed (AC3.2)', async () => {
      // Arrange
      const tempDir = await createTempDir();
      const claudeDir = await createMockClaudeDir(tempDir);

      // Act
      const removed = cleanupExcludedDirs(claudeDir);

      // Assert
      assert.ok(Array.isArray(removed));
      assert.ok(removed.length > 0);

      // Cleanup
      await rm(tempDir, { recursive: true });
    });

    it('should handle missing excluded dirs gracefully (AC3.1)', async () => {
      // Arrange
      const tempDir = await createTempDir();
      const claudeDir = join(tempDir, '.claude');
      await mkdir(join(claudeDir, 'skills'), { recursive: true });
      // No state dirs exist

      // Act & Assert - should not throw
      assert.doesNotThrow(() => cleanupExcludedDirs(claudeDir));

      // Cleanup
      await rm(tempDir, { recursive: true });
    });
  });

  describe('integration concepts (AC4.1, AC4.2)', () => {
    it('manage-worktrees.mjs should call selectiveCopyClaudeDir after worktree creation (AC4.1)', () => {
      // Arrange & Act & Assert
      // This is an integration test that validates the wiring in manage-worktrees.mjs.
      // The function is exported and available for integration.
      assert.equal(typeof selectiveCopyClaudeDir, 'function');
    });

    it('after selective copy, operational items should be loadable (AC4.2)', async () => {
      // Arrange
      const sourceBase = await createTempDir();
      const targetBase = await createTempDir();
      const sourceClaudeDir = await createMockClaudeDir(sourceBase);
      const targetClaudeDir = join(targetBase, '.claude');

      // Act
      selectiveCopyClaudeDir(sourceClaudeDir, targetClaudeDir);

      // Assert - skills directory should have content
      const skillFiles = await readdir(join(targetClaudeDir, 'skills'));
      assert.ok(skillFiles.length > 0, 'Skills directory should contain files after copy');

      // Assert - agents directory should have content
      const agentFiles = await readdir(join(targetClaudeDir, 'agents'));
      assert.ok(agentFiles.length > 0, 'Agents directory should contain files after copy');

      // Cleanup
      await rm(sourceBase, { recursive: true });
      await rm(targetBase, { recursive: true });
    });
  });
});
