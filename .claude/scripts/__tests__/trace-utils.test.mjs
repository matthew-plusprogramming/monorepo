/**
 * Unit tests for trace-utils.mjs
 *
 * Tests: as-002-trace-utils (AC-4.1, AC-4.2, AC-4.3, AC-4.4)
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs trace-utils.test.mjs
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import {
  globToRegex,
  matchesGlob,
  fileToModule,
  isTraceStale,
  loadTraceConfig,
  formatTimestamp,
  getTracePath,
  getHighLevelTracePath,
  TRACE_CONFIG_PATH,
  LOW_LEVEL_TRACE_DIR,
} from '../lib/trace-utils.mjs';

// --- Import hook-wrapper.mjs globToRegex for consistency verification (AC-4.4) ---
// We replicate the algorithm, so we verify by testing identical inputs produce identical outputs.

/**
 * Reference implementation of globToRegex from hook-wrapper.mjs.
 * Copied verbatim for AC-4.4 consistency verification.
 */
function hookWrapperGlobToRegex(pattern) {
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regexStr += '(.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(char)) {
      regexStr += '\\' + char;
      i += 1;
    } else {
      regexStr += char;
      i += 1;
    }
  }

  return regexStr;
}

/**
 * Reference matchesPattern from hook-wrapper.mjs.
 * Copied verbatim for AC-4.4 consistency verification.
 */
function hookWrapperMatchesPattern(filePath, pattern) {
  const patterns = pattern.split(',').map(p => p.trim());

  for (const p of patterns) {
    const regexStr = hookWrapperGlobToRegex(p);
    const regex = new RegExp('(^|/)' + regexStr + '$');
    if (regex.test(filePath)) {
      return true;
    }
  }

  return false;
}

// --- Test fixtures ---

/** Sample trace config for testing */
function createTestConfig() {
  return {
    version: 1,
    projectRoot: '.',
    modules: [
      {
        id: 'node-server',
        name: 'Node Server',
        description: 'Express API server',
        fileGlobs: ['apps/node-server/src/**'],
      },
      {
        id: 'dashboard',
        name: 'Dashboard',
        description: 'Next.js dashboard',
        fileGlobs: ['apps/dashboard/src/**', 'apps/dashboard/public/**'],
      },
      {
        id: 'claude-scripts',
        name: 'Claude Scripts',
        description: 'Claude Code hook scripts',
        fileGlobs: ['.claude/scripts/**'],
      },
      {
        id: 'platform-cdk',
        name: 'Platform CDK',
        description: 'CDK infrastructure',
        fileGlobs: ['cdk/platform-cdk/src/**'],
      },
    ],
  };
}

// ============================================================
// globToRegex tests
// ============================================================

describe('globToRegex', () => {
  it('should convert ** to .* (match anything including /)', () => {
    const result = globToRegex('src/**');
    expect(result).toBe('src/.*');
  });

  it('should convert * to [^/]* (match anything except /)', () => {
    const result = globToRegex('src/*.ts');
    expect(result).toBe('src/[^/]*\\.ts');
  });

  it('should convert ? to [^/] (match single non-slash char)', () => {
    const result = globToRegex('src/?.ts');
    expect(result).toBe('src/[^/]\\.ts');
  });

  it('should escape regex special characters', () => {
    const result = globToRegex('src/file.test.ts');
    expect(result).toBe('src/file\\.test\\.ts');
  });

  it('should handle patterns with no special characters', () => {
    const result = globToRegex('README');
    expect(result).toBe('README');
  });

  it('should handle complex patterns with mixed wildcards', () => {
    const result = globToRegex('apps/*/src/**/*.ts');
    expect(result).toBe('apps/[^/]*/src/(.*/)?[^/]*\\.ts');
  });
});

// ============================================================
// matchesGlob tests
// ============================================================

describe('matchesGlob', () => {
  it('should match files under ** glob', () => {
    expect(matchesGlob('apps/node-server/src/index.ts', 'apps/node-server/src/**')).toBeTruthy();
  });

  it('should match nested files under ** glob', () => {
    expect(matchesGlob('apps/node-server/src/handlers/auth.ts', 'apps/node-server/src/**')).toBeTruthy();
  });

  it('should NOT match files outside the glob boundary', () => {
    expect(matchesGlob('apps/dashboard/src/index.ts', 'apps/node-server/src/**')).toBeFalsy();
  });

  it('should match files with * wildcard (single directory level)', () => {
    expect(matchesGlob('src/file.ts', 'src/*.ts')).toBeTruthy();
  });

  it('should NOT match nested files with * wildcard', () => {
    expect(matchesGlob('src/nested/file.ts', 'src/*.ts')).toBeFalsy();
  });

  it('should support comma-separated patterns (OR logic)', () => {
    expect(matchesGlob('apps/dashboard/src/page.tsx', 'apps/dashboard/src/**, apps/dashboard/public/**')).toBeTruthy();
    expect(matchesGlob('apps/dashboard/public/icon.png', 'apps/dashboard/src/**, apps/dashboard/public/**')).toBeTruthy();
    expect(matchesGlob('apps/node-server/src/index.ts', 'apps/dashboard/src/**, apps/dashboard/public/**')).toBeFalsy();
  });

  it('should match exact file paths', () => {
    expect(matchesGlob('package.json', 'package.json')).toBeTruthy();
  });

  it('should handle .claude/ prefixed paths', () => {
    expect(matchesGlob('.claude/scripts/hook-wrapper.mjs', '.claude/scripts/**')).toBeTruthy();
  });

  it('should handle paths with leading ./', () => {
    // matchesGlob does not normalize -- caller (fileToModule) handles that
    expect(matchesGlob('apps/node-server/src/index.ts', 'apps/node-server/src/**')).toBeTruthy();
  });
});

// ============================================================
// AC-4.4: Glob matching consistency with hook-wrapper.mjs
// ============================================================

describe('glob matching consistency with hook-wrapper.mjs (AC-4.4)', () => {
  const testCases = [
    // [filePath, pattern, description]
    ['apps/node-server/src/index.ts', 'apps/node-server/src/**', 'nested under **'],
    ['apps/node-server/src/handlers/auth.handler.ts', 'apps/node-server/src/**', 'deeply nested'],
    ['apps/dashboard/src/page.tsx', 'apps/node-server/src/**', 'different app (should not match)'],
    ['src/file.ts', 'src/*.ts', 'single-level wildcard match'],
    ['src/nested/file.ts', 'src/*.ts', 'nested file with single wildcard (should not match)'],
    ['.claude/scripts/hook-wrapper.mjs', '.claude/scripts/**', '.claude prefix glob'],
    ['package.json', '*.json', 'root-level file extension match'],
    ['apps/dashboard/tsconfig.json', '*.json', 'nested json with root glob'],
    ['.claude/traces/high-level.md', '.claude/traces/**', 'trace file pattern'],
    ['.claude/traces/low-level/dev-team.md', '.claude/traces/**', 'low-level trace pattern'],
  ];

  for (const [filePath, pattern, desc] of testCases) {
    it(`consistency: ${desc} -- "${filePath}" vs "${pattern}"`, () => {
      const traceResult = matchesGlob(filePath, pattern);
      const hookResult = hookWrapperMatchesPattern(filePath, pattern);
      expect(traceResult).toBe(hookResult);
    });
  }

  // Also verify globToRegex produces identical output
  const patterns = [
    'src/**',
    'src/*.ts',
    'apps/*/src/**/*.ts',
    '.claude/scripts/**',
    'package.json',
    '*.json',
    '.claude/traces/low-level/*.json',
  ];

  for (const pattern of patterns) {
    it(`globToRegex consistency: "${pattern}"`, () => {
      expect(globToRegex(pattern)).toBe(hookWrapperGlobToRegex(pattern));
    });
  }
});

// ============================================================
// fileToModule tests (AC-4.1, AC-4.2)
// ============================================================

describe('fileToModule', () => {
  const config = createTestConfig();

  // AC-4.1: Returns correct module for files within glob boundaries
  it('AC-4.1: should return node-server module for file in apps/node-server/src/', () => {
    const result = fileToModule('apps/node-server/src/index.ts', config);
    expect(result).toBeTruthy();
    expect(result.id).toBe('node-server');
    expect(result.name).toBe('Node Server');
  });

  it('AC-4.1: should return dashboard module for file in apps/dashboard/src/', () => {
    const result = fileToModule('apps/dashboard/src/page.tsx', config);
    expect(result).toBeTruthy();
    expect(result.id).toBe('dashboard');
  });

  it('AC-4.1: should return dashboard module for file in apps/dashboard/public/', () => {
    const result = fileToModule('apps/dashboard/public/favicon.ico', config);
    expect(result).toBeTruthy();
    expect(result.id).toBe('dashboard');
  });

  it('AC-4.1: should return claude-scripts module for .claude/scripts/ files', () => {
    const result = fileToModule('.claude/scripts/hook-wrapper.mjs', config);
    expect(result).toBeTruthy();
    expect(result.id).toBe('claude-scripts');
  });

  it('AC-4.1: should return platform-cdk module for cdk files', () => {
    const result = fileToModule('cdk/platform-cdk/src/stacks/api-stack.ts', config);
    expect(result).toBeTruthy();
    expect(result.id).toBe('platform-cdk');
  });

  it('AC-4.1: should return correct module for deeply nested files', () => {
    const result = fileToModule('apps/node-server/src/handlers/auth/login.handler.ts', config);
    expect(result).toBeTruthy();
    expect(result.id).toBe('node-server');
  });

  // AC-4.2: Returns null for untraced files
  it('AC-4.2: should return null for files not in any module glob', () => {
    const result = fileToModule('README.md', config);
    expect(result).toBe(null);
  });

  it('AC-4.2: should return null for package.json at root', () => {
    const result = fileToModule('package.json', config);
    expect(result).toBe(null);
  });

  it('AC-4.2: should return null for files in unlisted directories', () => {
    const result = fileToModule('some-other-app/src/index.ts', config);
    expect(result).toBe(null);
  });

  it('AC-4.2: should return null for empty file path', () => {
    const result = fileToModule('', config);
    expect(result).toBe(null);
  });

  it('AC-4.2: should return null for null file path', () => {
    const result = fileToModule(null, config);
    expect(result).toBe(null);
  });

  // First-match-wins behavior (REQ-AT-022)
  it('should use first-match-wins when modules have overlapping globs', () => {
    const overlappingConfig = {
      version: 1,
      modules: [
        { id: 'first', name: 'First', fileGlobs: ['src/**'] },
        { id: 'second', name: 'Second', fileGlobs: ['src/special/**'] },
      ],
    };
    const result = fileToModule('src/special/file.ts', overlappingConfig);
    expect(result).toBeTruthy();
    expect(result.id).toBe('first');
  });

  // Edge: path with leading ./
  it('should handle paths with leading ./', () => {
    const result = fileToModule('./apps/node-server/src/index.ts', config);
    expect(result).toBeTruthy();
    expect(result.id).toBe('node-server');
  });

  // Edge: path with leading /
  it('should handle paths with leading /', () => {
    const result = fileToModule('/apps/node-server/src/index.ts', config);
    expect(result).toBeTruthy();
    expect(result.id).toBe('node-server');
  });

  // Edge: null/missing config
  it('should return null for null config', () => {
    const result = fileToModule('apps/node-server/src/index.ts', null);
    expect(result).toBe(null);
  });

  it('should return null for config with no modules array', () => {
    const result = fileToModule('apps/node-server/src/index.ts', { version: 1 });
    expect(result).toBe(null);
  });
});

// ============================================================
// loadTraceConfig tests
// ============================================================

describe('loadTraceConfig', () => {
  let testRoot;

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-config-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(testRoot, '.claude', 'traces'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should load and parse a valid trace config', () => {
    const config = createTestConfig();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify(config, null, 2),
    );

    const loaded = loadTraceConfig(testRoot);
    expect(loaded.version).toBe(1);
    expect(loaded.modules.length).toBe(4);
    expect(loaded.modules[0].id).toBe('node-server');
  });

  it('should throw if config file does not exist', () => {
    expect(() => loadTraceConfig(testRoot + '-nonexistent')).toThrow(/Trace config not found/);
  });

  it('should throw for invalid JSON', () => {
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      'not json {{{',
    );

    expect(() => loadTraceConfig(testRoot)).toThrow(/Failed to parse trace config JSON/);
  });

  it('should throw if version is missing', () => {
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify({ modules: [] }),
    );

    expect(() => loadTraceConfig(testRoot)).toThrow(/"version" must be a number/);
  });

  it('should throw if modules is not an array', () => {
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify({ version: 1, modules: 'not-array' }),
    );

    expect(() => loadTraceConfig(testRoot)).toThrow(/"modules" must be an array/);
  });

  it('should throw if a module has no id', () => {
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify({
        version: 1,
        modules: [{ name: 'Test', fileGlobs: ['src/**'] }],
      }),
    );

    expect(() => loadTraceConfig(testRoot)).toThrow(/modules\[0\]\.id must be a non-empty string/);
  });

  it('should throw if a module has empty fileGlobs', () => {
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'trace.config.json'),
      JSON.stringify({
        version: 1,
        modules: [{ id: 'test', name: 'Test', fileGlobs: [] }],
      }),
    );

    expect(() => loadTraceConfig(testRoot)).toThrow(/modules\[0\]\.fileGlobs must be a non-empty array/);
  });
});

// ============================================================
// isTraceStale tests (AC-4.3)
// ============================================================

describe('isTraceStale', () => {
  let testRoot;
  const config = createTestConfig();

  beforeEach(() => {
    const timestamp = Date.now();
    testRoot = join(
      tmpdir(),
      `trace-stale-test-${timestamp}-${Math.random().toString(36).slice(2)}`,
    );

    // Create directory structure
    mkdirSync(join(testRoot, '.claude', 'traces', 'low-level'), { recursive: true });
    mkdirSync(join(testRoot, 'apps', 'node-server', 'src'), { recursive: true });

    // Initialize a git repo so git ls-files works
    execSync('git init', { cwd: testRoot });
    execSync('git config user.email "test@test.com"', { cwd: testRoot });
    execSync('git config user.name "Test"', { cwd: testRoot });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('AC-4.3: should return true when trace file does not exist', () => {
    // No trace file -- treat as stale
    const result = isTraceStale('node-server', config, testRoot);
    expect(result).toBe(true);
  });

  it('AC-4.3: should return true when lastGenerated is missing from trace', () => {
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'node-server.json'),
      JSON.stringify({ moduleId: 'node-server', version: 1, files: [] }),
    );

    const result = isTraceStale('node-server', config, testRoot);
    expect(result).toBe(true);
  });

  it('AC-4.3: should return false when no matching files exist', () => {
    // Trace exists with recent timestamp, but no source files are tracked by git
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'node-server.json'),
      JSON.stringify({
        moduleId: 'node-server',
        version: 1,
        lastGenerated: new Date().toISOString(),
        files: [],
      }),
    );

    const result = isTraceStale('node-server', config, testRoot);
    expect(result).toBe(false);
  });

  it('should return false for modules not in config', () => {
    const result = isTraceStale('nonexistent-module', config, testRoot);
    expect(result).toBe(false);
  });

  it('AC-4.3: should return true when source file is newer than lastGenerated', () => {
    // Create a source file and add to git
    const srcFile = join(testRoot, 'apps', 'node-server', 'src', 'index.ts');
    writeFileSync(srcFile, 'export const x = 1;');
    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init" --allow-empty', { cwd: testRoot });

    // Set trace lastGenerated to 1 hour ago
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'node-server.json'),
      JSON.stringify({
        moduleId: 'node-server',
        version: 1,
        lastGenerated: oneHourAgo,
        files: [],
      }),
    );

    // Touch the source file to make it newer
    const now = new Date();
    utimesSync(srcFile, now, now);

    const result = isTraceStale('node-server', config, testRoot);
    expect(result).toBe(true);
  });

  it('AC-4.3: should return false when source files are older than lastGenerated', () => {
    // Create a source file with an old timestamp
    const srcFile = join(testRoot, 'apps', 'node-server', 'src', 'index.ts');
    writeFileSync(srcFile, 'export const x = 1;');

    // Set file mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 7200000);
    utimesSync(srcFile, twoHoursAgo, twoHoursAgo);

    execSync('git add .', { cwd: testRoot });
    execSync('git commit -m "init" --allow-empty', { cwd: testRoot });

    // Set trace lastGenerated to 1 hour ago (after the source file)
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    writeFileSync(
      join(testRoot, '.claude', 'traces', 'low-level', 'node-server.json'),
      JSON.stringify({
        moduleId: 'node-server',
        version: 1,
        lastGenerated: oneHourAgo,
        files: [],
      }),
    );

    const result = isTraceStale('node-server', config, testRoot);
    expect(result).toBe(false);
  });
});

// ============================================================
// formatTimestamp tests
// ============================================================

describe('formatTimestamp', () => {
  it('should return ISO 8601 format', () => {
    const result = formatTimestamp(new Date('2026-02-22T10:30:00Z'));
    expect(result).toBe('2026-02-22T10:30:00.000Z');
  });

  it('should use current time when no date provided', () => {
    const before = new Date().toISOString();
    const result = formatTimestamp();
    const after = new Date().toISOString();

    expect(result >= before).toBeTruthy();
    expect(result <= after).toBeTruthy();
  });

  it('should produce a parseable ISO string', () => {
    const result = formatTimestamp();
    const parsed = new Date(result);
    expect(Number.isNaN(parsed.getTime())).toBeFalsy();
  });
});

// ============================================================
// getTracePath / getHighLevelTracePath tests
// ============================================================

describe('getTracePath', () => {
  it('should return path to low-level trace JSON', () => {
    const result = getTracePath('node-server', '/project');
    expect(result).toBe('/project/.claude/traces/low-level/node-server.json');
  });

  it('should handle module IDs with hyphens', () => {
    const result = getTracePath('dev-team', '/project');
    expect(result).toBe('/project/.claude/traces/low-level/dev-team.json');
  });
});

describe('getHighLevelTracePath', () => {
  it('should return path to high-level trace JSON', () => {
    const result = getHighLevelTracePath('/project');
    expect(result).toBe('/project/.claude/traces/high-level.json');
  });
});

// ============================================================
// Exported constants
// ============================================================

describe('exported constants', () => {
  it('should export TRACE_CONFIG_PATH', () => {
    expect(TRACE_CONFIG_PATH).toBe('.claude/traces/trace.config.json');
  });

  it('should export LOW_LEVEL_TRACE_DIR', () => {
    expect(LOW_LEVEL_TRACE_DIR).toBe('.claude/traces/low-level');
  });
});
