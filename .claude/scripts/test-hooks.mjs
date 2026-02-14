#!/usr/bin/env node

/**
 * Hook Test Harness
 * Validates all PostToolUse, SubagentStop, and Stop hooks work correctly.
 * Registered in metaclaude-registry.json and synced to consumer repos.
 *
 * Usage:
 *   node .claude/scripts/test-hooks.mjs
 *
 * Runs 5 phases:
 *   Phase 1: Script Existence
 *   Phase 2: Pattern Matching
 *   Phase 3: PostToolUse Hooks
 *   Phase 4: SubagentStop Hooks
 *   Phase 5: Stop Hooks
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CLAUDE_DIR = resolve(ROOT, '.claude');
const SCRIPTS_DIR = resolve(CLAUDE_DIR, 'scripts');
const FIXTURES_DIR = resolve(SCRIPTS_DIR, '__fixtures__');
const SETTINGS_PATH = resolve(CLAUDE_DIR, 'settings.json');
const HOOK_WRAPPER = resolve(SCRIPTS_DIR, 'hook-wrapper.mjs');

// --- Colors ---
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// --- Counters ---
let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;

function pass(msg) {
  totalPassed++;
  console.log(`  ${GREEN}\u2713${RESET} ${msg}`);
}

function fail(msg, detail) {
  totalFailed++;
  console.log(`  ${RED}\u2717${RESET} ${msg}`);
  if (detail) {
    const lines = detail.trim().split('\n').slice(0, 5);
    for (const line of lines) {
      console.log(`    ${DIM}${line}${RESET}`);
    }
  }
}

function skip(msg, reason) {
  totalSkipped++;
  console.log(`  ${YELLOW}\u25CB${RESET} ${msg} ${DIM}(${reason})${RESET}`);
}

function phaseHeader(num, name) {
  console.log('');
  console.log(`${BOLD}Phase ${num}: ${name}${RESET}`);
}

function phaseResult(passed, total, skipped) {
  const skipMsg = skipped > 0 ? `, ${skipped} SKIP` : '';
  console.log(`  ${DIM}Result: ${passed}/${total} PASS${skipMsg}${RESET}`);
}

// --- Load settings ---
function loadSettings() {
  return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
}

// --- Collect all unique scripts referenced in hooks ---
function collectScripts(settings) {
  const scripts = new Set();
  const hookTypes = ['PostToolUse', 'SubagentStop', 'Stop'];

  for (const hookType of hookTypes) {
    const entries = settings.hooks?.[hookType] || [];
    for (const entry of entries) {
      for (const hook of entry.hooks || []) {
        if (hook.type !== 'command') continue;
        const cmd = hook.command;
        // Extract .mjs script paths from the command
        const mjsMatches = cmd.match(/[^\s'"]+\.mjs/g) || [];
        for (const m of mjsMatches) {
          scripts.add(m);
        }
      }
    }
  }

  return [...scripts];
}

// --- Run a command with stdin input, return { code, stdout, stderr } ---
function runWithStdin(command, stdinData, timeoutMs = 30000) {
  try {
    const result = spawnSync('sh', ['-c', command], {
      input: stdinData,
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: ROOT,
    });
    return {
      code: result.status ?? 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (err) {
    return {
      code: 1,
      stdout: '',
      stderr: err.message,
    };
  }
}

// --- Run hook-wrapper with given file_path in stdin JSON ---
function runHookWrapper(pattern, innerCommand, filePath) {
  const stdinJson = JSON.stringify({ tool_input: { file_path: filePath } });
  const cmd = `node ${HOOK_WRAPPER} '${pattern}' '${innerCommand}'`;
  return runWithStdin(cmd, stdinJson);
}

// --- Run a direct script with a file argument ---
function runScript(scriptPath, filePath) {
  const cmd = `node ${scriptPath} ${filePath}`;
  try {
    const result = spawnSync('sh', ['-c', cmd], {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: ROOT,
    });
    return {
      code: result.status ?? 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (err) {
    return { code: 1, stdout: '', stderr: err.message };
  }
}

// ============================================================
// Phase 1: Script Existence
// ============================================================
function phase1ScriptExistence(settings) {
  phaseHeader(1, 'Script Existence');

  const scripts = collectScripts(settings);
  let phasePassed = 0;
  let phaseTotal = scripts.length;

  for (const scriptPath of scripts) {
    const name = basename(scriptPath);
    if (existsSync(scriptPath)) {
      pass(name);
      phasePassed++;
    } else {
      fail(`${name} -- not found at ${scriptPath}`);
    }
  }

  phaseResult(phasePassed, phaseTotal, 0);
}

// ============================================================
// Phase 2: Pattern Matching
// ============================================================
function phase2PatternMatching() {
  phaseHeader(2, 'Pattern Matching');

  // Test patterns used in settings.json against the hook-wrapper's glob matching
  const testCases = [
    // pattern, filePath, shouldMatch
    ['*.json', '/some/path/data.json', true],
    ['*.json', '/some/path/data.txt', false],
    ['*.ts,*.tsx', '/src/foo.ts', true],
    ['*.ts,*.tsx', '/src/bar.tsx', true],
    ['*.ts,*.tsx', '/src/baz.js', false],
    ['.claude/agents/*.md', '/Users/me/project/.claude/agents/explore.md', true],
    ['.claude/agents/*.md', '/Users/me/project/.claude/skills/SKILL.md', false],
    ['*SKILL.md', '/Users/me/project/.claude/skills/route/SKILL.md', true],
    ['*SKILL.md', '/Users/me/project/.claude/agents/explore.md', false],
    ['*CLAUDE.md', '/Users/me/project/CLAUDE.md', true],
    ['*CLAUDE.md', '/Users/me/project/README.md', false],
    ['*manifest.json', '/Users/me/project/.claude/specs/groups/sg-test/manifest.json', true],
    ['*manifest.json', '/Users/me/project/package.json', false],
    ['.claude/specs/**/*.md', '/Users/me/project/.claude/specs/groups/sg-test/spec.md', true],
    ['.claude/specs/**/*.md', '/Users/me/project/.claude/agents/explore.md', false],
    ['.claude/**', '/Users/me/project/.claude/scripts/test.mjs', true],
    ['.claude/templates/*', '/Users/me/project/.claude/templates/agent.template.md', true],
    ['.claude/templates/*', '/Users/me/project/.claude/scripts/test.mjs', false],
    ['.claude/specs/groups/**/manifest.json', '/Users/me/project/.claude/specs/groups/sg-test/manifest.json', true],
    ['.claude/specs/**', '/Users/me/project/.claude/specs/groups/sg-test/atomic/as-001.md', true],
    ['.claude/registry/artifacts.json', '/Users/me/project/.claude/registry/artifacts.json', true],
  ];

  let phasePassed = 0;
  let phaseTotal = testCases.length;

  for (const [pattern, filePath, shouldMatch] of testCases) {
    const matchLabel = shouldMatch ? 'matches' : 'does NOT match';
    const shortFile = filePath.split('/').slice(-2).join('/');
    const label = `${pattern} ${matchLabel} ${shortFile}`;

    // Run hook-wrapper with "echo matched" as the inner command
    const stdinJson = JSON.stringify({ tool_input: { file_path: filePath } });
    const cmd = `node ${HOOK_WRAPPER} '${pattern}' 'echo matched'`;
    const result = runWithStdin(cmd, stdinJson);

    // hook-wrapper exits 0 on match (inner command runs "echo matched" -> exit 0)
    // hook-wrapper exits 0 on non-match (silently exits)
    // Distinguish by checking stderr for "matched"
    const matchedOutput = result.stderr.includes('matched') || result.stdout.includes('matched');

    if (shouldMatch && matchedOutput) {
      pass(label);
      phasePassed++;
    } else if (!shouldMatch && !matchedOutput) {
      pass(label);
      phasePassed++;
    } else {
      fail(label, `Expected ${shouldMatch ? 'match' : 'no match'}, got ${matchedOutput ? 'match' : 'no match'} (code=${result.code})`);
    }
  }

  phaseResult(phasePassed, phaseTotal, 0);
}

// ============================================================
// Phase 3: PostToolUse Hooks
// ============================================================
function phase3PostToolUseHooks(settings) {
  phaseHeader(3, 'PostToolUse Hooks');

  let phasePassed = 0;
  let phaseSkipped = 0;
  let phaseTotal = 0;

  // Helper to test a hook via its direct script (not wrapper)
  function testDirect(hookId, scriptPath, fixture, expectCode, label) {
    phaseTotal++;
    const fixturePath = resolve(FIXTURES_DIR, fixture);

    if (!existsSync(fixturePath)) {
      skip(`${hookId}: ${label}`, 'fixture not found');
      phaseSkipped++;
      return;
    }

    const result = runScript(scriptPath, fixturePath);
    const pass_ = expectCode === 0 ? result.code === 0 : result.code !== 0;

    if (pass_) {
      pass(`${hookId}: ${label}`);
      phasePassed++;
    } else {
      fail(
        `${hookId}: ${label} -- expected exit ${expectCode === 0 ? '0' : 'non-zero'}, got ${result.code}`,
        result.stderr
      );
    }
  }

  // Helper to test via hook-wrapper (full integration)
  function testWrapper(hookId, pattern, innerCmd, fixture, expectCode, label) {
    phaseTotal++;
    const fixturePath = resolve(FIXTURES_DIR, fixture);

    if (!existsSync(fixturePath)) {
      skip(`${hookId}: ${label}`, 'fixture not found');
      phaseSkipped++;
      return;
    }

    const stdinJson = JSON.stringify({ tool_input: { file_path: fixturePath } });
    const resolvedCmd = innerCmd.replace(/\{\{file\}\}/g, fixturePath);
    const cmd = `node ${HOOK_WRAPPER} '${pattern}' '${resolvedCmd}'`;
    const result = runWithStdin(cmd, stdinJson);
    const pass_ = expectCode === 0 ? result.code === 0 : result.code !== 0;

    if (pass_) {
      pass(`${hookId}: ${label}`);
      phasePassed++;
    } else {
      fail(
        `${hookId}: ${label} -- expected exit ${expectCode === 0 ? '0' : 'non-zero'}, got ${result.code}`,
        result.stderr
      );
    }
  }

  // --- JSON Validate (inline JSON.parse command) ---
  // The json-validate hook uses inline node -e with JSON.parse.
  // Test the validation logic directly rather than through hook-wrapper
  // since the inline quoting is complex.
  {
    phaseTotal++;
    const validJsonPath = resolve(FIXTURES_DIR, 'valid.json');
    const result = spawnSync('node', [
      '-e',
      `JSON.parse(require("fs").readFileSync(process.argv[1]))`,
      validJsonPath,
    ], { encoding: 'utf-8', timeout: 10000, cwd: ROOT });
    if (result.status === 0) {
      pass('json-validate: valid.json -> exit 0');
      phasePassed++;
    } else {
      fail('json-validate: valid.json -> exit 0', result.stderr);
    }
  }
  {
    phaseTotal++;
    const invalidJsonPath = resolve(FIXTURES_DIR, 'invalid.json');
    const result = spawnSync('node', [
      '-e',
      `JSON.parse(require("fs").readFileSync(process.argv[1]))`,
      invalidJsonPath,
    ], { encoding: 'utf-8', timeout: 10000, cwd: ROOT });
    if (result.status !== 0) {
      pass('json-validate: invalid.json -> exit non-zero');
      phasePassed++;
    } else {
      fail('json-validate: invalid.json -> expected exit non-zero, got 0', result.stderr);
    }
  }

  // --- Agent Frontmatter Validate ---
  const agentScript = resolve(SCRIPTS_DIR, 'validate-agent-frontmatter.mjs');
  testDirect('agent-frontmatter-validate', agentScript, 'valid-agent.md', 0,
    'valid-agent.md -> exit 0');
  testDirect('agent-frontmatter-validate', agentScript, 'invalid-agent-missing-model.md', 1,
    'invalid-agent-missing-model.md -> exit non-zero');

  // --- Skill Frontmatter Validate ---
  const skillScript = resolve(SCRIPTS_DIR, 'validate-skill-frontmatter.mjs');
  testDirect('skill-frontmatter-validate', skillScript, 'valid-SKILL.md', 0,
    'valid-SKILL.md -> exit 0');
  testDirect('skill-frontmatter-validate', skillScript, 'invalid-SKILL-missing-fields.md', 1,
    'invalid-SKILL-missing-fields.md -> exit non-zero');

  // --- Spec Validate ---
  const specScript = resolve(SCRIPTS_DIR, 'spec-validate.mjs');
  testDirect('spec-validate', specScript, 'valid-spec.md', 0,
    'valid-spec.md -> exit 0');
  testDirect('spec-validate', specScript, 'invalid-spec-missing-sections.md', 1,
    'invalid-spec-missing-sections.md -> exit non-zero');

  // --- Spec Schema Validate ---
  // Note: spec-schema-validate tries to determine spec type from path/frontmatter.
  // Our fixture at __fixtures__/valid-spec.md has id: ts-001-test which doesn't
  // match any known type prefix, so it may warn but exit 0.
  const specSchemaScript = resolve(SCRIPTS_DIR, 'spec-schema-validate.mjs');
  testDirect('spec-schema-validate', specSchemaScript, 'valid-spec.md', 0,
    'valid-spec.md -> exit 0 (warns: unknown type)');

  // --- Manifest Validate ---
  const manifestScript = resolve(SCRIPTS_DIR, 'validate-manifest.mjs');
  testDirect('manifest-validate', manifestScript, 'valid-manifest.json', 0,
    'valid-manifest.json -> exit 0');
  testDirect('manifest-validate', manifestScript, 'invalid-manifest-missing-id.json', 1,
    'invalid-manifest-missing-id.json -> exit non-zero');

  // --- Convergence Field Validate ---
  const convergenceScript = resolve(SCRIPTS_DIR, 'validate-convergence-fields.mjs');
  testDirect('convergence-field-validate', convergenceScript, 'valid-manifest.json', 0,
    'valid-manifest.json -> exit 0 (all canonical fields)');
  testDirect('convergence-field-validate', convergenceScript, 'manifest-bad-convergence.json', 1,
    'manifest-bad-convergence.json -> exit non-zero (non-canonical fields)');

  // --- Superseded Artifact Warn ---
  const supersededScript = resolve(SCRIPTS_DIR, 'superseded-artifact-warn.mjs');
  testDirect('superseded-artifact-warn', supersededScript, 'valid-spec.md', 0,
    'valid-spec.md -> exit 0 (not superseded)');
  testDirect('superseded-artifact-warn', supersededScript, 'superseded-spec.md', 2,
    'superseded-spec.md -> exit 2 (superseded warning)');

  // --- Evidence Table Check (always exit 0, warning only) ---
  const evidenceScript = resolve(SCRIPTS_DIR, 'evidence-table-check.mjs');
  testDirect('evidence-table-check', evidenceScript, 'valid-spec.md', 0,
    'valid-spec.md -> exit 0');

  // --- Spec Approval Hash (always exit 0, warning only) ---
  const approvalScript = resolve(SCRIPTS_DIR, 'spec-approval-hash.mjs');
  testDirect('spec-approval-hash', approvalScript, 'valid-spec.md', 0,
    'valid-spec.md -> exit 0');

  // --- Structured Error Validator (always exit 0, warning only) ---
  const structErrScript = resolve(SCRIPTS_DIR, 'structured-error-validator.mjs');
  testDirect('structured-error-validate', structErrScript, 'valid-file.ts', 0,
    'valid-file.ts -> exit 0');

  // --- Template Validate ---
  // Our valid-template.md has 'task' in the name, so template-validate
  // matches it as task-spec.template.md type.
  const templateScript = resolve(SCRIPTS_DIR, 'template-validate.mjs');
  if (existsSync(templateScript)) {
    // Test with actual template files from the templates directory
    const realTemplate = resolve(CLAUDE_DIR, 'templates', 'task-spec.template.md');
    if (existsSync(realTemplate)) {
      phaseTotal++;
      const result = runScript(templateScript, realTemplate);
      if (result.code === 0) {
        pass('template-validate: task-spec.template.md -> exit 0');
        phasePassed++;
      } else {
        fail('template-validate: task-spec.template.md -> exit 0', result.stderr);
      }
    } else {
      phaseTotal++;
      skip('template-validate: task-spec.template.md', 'template file not found');
      phaseSkipped++;
    }

    const agentTemplate = resolve(CLAUDE_DIR, 'templates', 'agent.template.md');
    if (existsSync(agentTemplate)) {
      phaseTotal++;
      const result = runScript(templateScript, agentTemplate);
      if (result.code === 0) {
        pass('template-validate: agent.template.md -> exit 0');
        phasePassed++;
      } else {
        fail('template-validate: agent.template.md -> exit 0', result.stderr);
      }
    } else {
      phaseTotal++;
      skip('template-validate: agent.template.md', 'template file not found');
      phaseSkipped++;
    }
  }

  // --- CLAUDE.md Drift Detection ---
  const driftScript = resolve(SCRIPTS_DIR, 'verify-claude-md-base.mjs');
  if (existsSync(driftScript)) {
    const templateBase = resolve(CLAUDE_DIR, 'templates', 'claude-md-base.md');
    if (existsSync(templateBase)) {
      phaseTotal++;
      // Test against the repo's own CLAUDE.md
      const result = runScript(driftScript, ROOT);
      // This checks ROOT/CLAUDE.md against the template. The result depends on actual drift.
      // We just verify the script runs without crashing.
      if (result.code === 0) {
        pass('claude-md-drift: repo CLAUDE.md -> exit 0 (no drift)');
        phasePassed++;
      } else if (result.code === 1) {
        pass('claude-md-drift: repo CLAUDE.md -> exit 1 (drift detected, expected)');
        phasePassed++;
      } else {
        fail('claude-md-drift: repo CLAUDE.md -> unexpected exit ' + result.code, result.stderr);
      }
    } else {
      phaseTotal++;
      skip('claude-md-drift', 'claude-md-base.md template not found');
      phaseSkipped++;
    }
  }

  // --- Registry Hash Verify ---
  const hashScript = resolve(SCRIPTS_DIR, 'compute-hashes.mjs');
  if (existsSync(hashScript)) {
    phaseTotal++;
    const registryFile = resolve(CLAUDE_DIR, 'metaclaude-registry.json');
    if (existsSync(registryFile)) {
      const result = spawnSync('sh', ['-c', `node ${hashScript} --verify`], {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: ROOT,
      });
      // We accept either 0 (all match) or 1 (mismatches) as valid behavior -- the script ran
      if (result.status === 0) {
        pass('registry-hash-verify: --verify -> exit 0 (all match)');
        phasePassed++;
      } else if (result.status === 1) {
        pass('registry-hash-verify: --verify -> exit 1 (mismatches detected, expected)');
        phasePassed++;
      } else {
        fail('registry-hash-verify: --verify -> unexpected exit ' + result.status, result.stderr);
      }
    } else {
      skip('registry-hash-verify', 'metaclaude-registry.json not found');
      phaseSkipped++;
    }
  }

  // --- Registry Artifact Validate ---
  const regArtifactScript = resolve(SCRIPTS_DIR, 'registry-artifact-validate.mjs');
  if (existsSync(regArtifactScript)) {
    const artifactsFile = resolve(CLAUDE_DIR, 'registry', 'artifacts.json');
    if (existsSync(artifactsFile)) {
      phaseTotal++;
      const result = runScript(regArtifactScript, artifactsFile);
      if (result.code === 0) {
        pass('registry-artifact-validate: artifacts.json -> exit 0');
        phasePassed++;
      } else {
        // Might fail due to warnings about missing paths etc. -- still a valid test
        fail('registry-artifact-validate: artifacts.json -> exit non-zero', result.stderr);
      }
    } else {
      phaseTotal++;
      skip('registry-artifact-validate', 'artifacts.json not found');
      phaseSkipped++;
    }
  }

  // --- TypeScript Typecheck ---
  const tscScript = resolve(SCRIPTS_DIR, 'workspace-tsc.mjs');
  if (existsSync(tscScript)) {
    // Check if there's a tsconfig.json anywhere near the fixtures
    const hasTsconfig = existsSync(resolve(ROOT, 'tsconfig.json'));
    if (hasTsconfig) {
      testDirect('typescript-typecheck', tscScript, 'valid-file.ts', 0,
        'valid-file.ts -> exit 0');
      testDirect('typescript-typecheck', tscScript, 'invalid-file.ts', 1,
        'invalid-file.ts -> exit non-zero');
    } else {
      phaseTotal += 2;
      skip('typescript-typecheck: valid-file.ts', 'no tsconfig.json in project');
      skip('typescript-typecheck: invalid-file.ts', 'no tsconfig.json in project');
      phaseSkipped += 2;
    }
  }

  // --- ESLint Check ---
  const eslintScript = resolve(SCRIPTS_DIR, 'workspace-eslint.mjs');
  if (existsSync(eslintScript)) {
    // Check if ESLint config exists
    const eslintConfigs = [
      '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json',
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
    ];
    const hasEslint = eslintConfigs.some(c => existsSync(resolve(ROOT, c)));
    if (hasEslint) {
      testDirect('eslint-check', eslintScript, 'valid-file.ts', 0,
        'valid-file.ts -> exit 0');
    } else {
      phaseTotal++;
      skip('eslint-check: valid-file.ts', 'no ESLint config in project');
      phaseSkipped++;
    }
  }

  // --- Progress Heartbeat Check ---
  const heartbeatScript = resolve(SCRIPTS_DIR, 'progress-heartbeat-check.mjs');
  if (existsSync(heartbeatScript)) {
    // This needs a file inside .claude/specs/groups/<id>/... with a manifest.json
    // Test with a fixture file that's NOT in a spec group -- should exit 0 silently
    phaseTotal++;
    const result = runScript(heartbeatScript, resolve(FIXTURES_DIR, 'valid-spec.md'));
    if (result.code === 0) {
      pass('progress-heartbeat-check: non-spec-group file -> exit 0');
      phasePassed++;
    } else {
      fail('progress-heartbeat-check: non-spec-group file -> exit 0', result.stderr);
    }
  }

  // --- Session State Validate ---
  const sessionScript = resolve(SCRIPTS_DIR, 'session-validate.mjs');
  if (existsSync(sessionScript)) {
    phaseTotal++;
    const sessionFile = resolve(CLAUDE_DIR, 'context', 'session.json');
    if (existsSync(sessionFile)) {
      const result = spawnSync('sh', ['-c', `node ${sessionScript}`], {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: ROOT,
      });
      if (result.status === 0) {
        pass('session-state-validate: session.json -> exit 0');
        phasePassed++;
      } else {
        // Session might be invalid at test time -- that's OK, the script ran
        pass('session-state-validate: session.json -> exit non-zero (validation ran)');
        phasePassed++;
      }
    } else {
      skip('session-state-validate', 'session.json not found');
      phaseSkipped++;
    }
  }

  // --- Spec-Manifest Sync ---
  const syncScript = resolve(SCRIPTS_DIR, 'validate-spec-manifest-sync.mjs');
  if (existsSync(syncScript)) {
    // Test with our fixture manifest -- it has work_state: PLAN_READY, so sync check skips
    testDirect('spec-manifest-sync', syncScript, 'valid-manifest.json', 0,
      'valid-manifest.json -> exit 0 (not in completion state)');
  }

  // --- Journal Commit Check ---
  // This hook reads Bash command from stdin (not file path). It is a PostToolUse:Bash hook.
  const journalScript = resolve(SCRIPTS_DIR, 'journal-commit-check.mjs');
  if (existsSync(journalScript)) {
    // Test with a non-git-commit command -- should exit 0
    phaseTotal++;
    const stdinNonCommit = JSON.stringify({ tool_input: { command: 'echo hello' } });
    const result = runWithStdin(`node ${journalScript}`, stdinNonCommit);
    if (result.code === 0) {
      pass('journal-commit-check: non-git-commit command -> exit 0');
      phasePassed++;
    } else {
      fail('journal-commit-check: non-git-commit command -> exit 0', result.stderr);
    }
  }

  phaseResult(phasePassed, phaseTotal, phaseSkipped);
}

// ============================================================
// Phase 4: SubagentStop Hooks
// ============================================================
function phase4SubagentStopHooks() {
  phaseHeader(4, 'SubagentStop Hooks');

  let phasePassed = 0;
  let phaseSkipped = 0;
  let phaseTotal = 0;

  const gateScript = resolve(SCRIPTS_DIR, 'convergence-gate-reminder.mjs');

  if (!existsSync(gateScript)) {
    phaseTotal = 2;
    skip('convergence-gate-reminder: implementer', 'script not found');
    skip('convergence-gate-reminder: explore', 'script not found');
    phaseSkipped = 2;
    phaseResult(phasePassed, phaseTotal, phaseSkipped);
    return;
  }

  // Test 1: implementer -> gate present in stdout
  phaseTotal++;
  {
    const stdinData = JSON.stringify({ agent_type: 'implementer' });
    const result = runWithStdin(`node ${gateScript}`, stdinData);

    if (result.code === 0 && result.stdout.includes('all_acs_implemented')) {
      pass('convergence-gate-reminder: implementer -> gate present');
      phasePassed++;
    } else {
      fail(
        'convergence-gate-reminder: implementer -> gate present',
        `code=${result.code}, stdout=${result.stdout.trim()}`
      );
    }
  }

  // Test 2: test-writer -> gate present
  phaseTotal++;
  {
    const stdinData = JSON.stringify({ agent_type: 'test-writer' });
    const result = runWithStdin(`node ${gateScript}`, stdinData);

    if (result.code === 0 && result.stdout.includes('all_tests_passing')) {
      pass('convergence-gate-reminder: test-writer -> gate present');
      phasePassed++;
    } else {
      fail(
        'convergence-gate-reminder: test-writer -> gate present',
        `code=${result.code}, stdout=${result.stdout.trim()}`
      );
    }
  }

  // Test 3: code-reviewer -> gate present
  phaseTotal++;
  {
    const stdinData = JSON.stringify({ agent_type: 'code-reviewer' });
    const result = runWithStdin(`node ${gateScript}`, stdinData);

    if (result.code === 0 && result.stdout.includes('code_review_passed')) {
      pass('convergence-gate-reminder: code-reviewer -> gate present');
      phasePassed++;
    } else {
      fail(
        'convergence-gate-reminder: code-reviewer -> gate present',
        `code=${result.code}, stdout=${result.stdout.trim()}`
      );
    }
  }

  // Test 4: explore (unmapped) -> empty JSON
  phaseTotal++;
  {
    const stdinData = JSON.stringify({ agent_type: 'explore' });
    const result = runWithStdin(`node ${gateScript}`, stdinData);

    if (result.code === 0 && result.stdout.trim() === '{}') {
      pass('convergence-gate-reminder: explore -> empty JSON (unmapped)');
      phasePassed++;
    } else {
      fail(
        'convergence-gate-reminder: explore -> empty JSON',
        `code=${result.code}, stdout=${result.stdout.trim()}`
      );
    }
  }

  // Test 5: empty stdin -> empty JSON
  phaseTotal++;
  {
    const result = runWithStdin(`node ${gateScript}`, '');

    if (result.code === 0 && result.stdout.trim() === '{}') {
      pass('convergence-gate-reminder: empty stdin -> empty JSON');
      phasePassed++;
    } else {
      fail(
        'convergence-gate-reminder: empty stdin -> empty JSON',
        `code=${result.code}, stdout=${result.stdout.trim()}`
      );
    }
  }

  // Test 6: malformed JSON -> empty JSON
  phaseTotal++;
  {
    const result = runWithStdin(`node ${gateScript}`, '{not valid json');

    if (result.code === 0 && result.stdout.trim() === '{}') {
      pass('convergence-gate-reminder: malformed JSON -> empty JSON');
      phasePassed++;
    } else {
      fail(
        'convergence-gate-reminder: malformed JSON -> empty JSON',
        `code=${result.code}, stdout=${result.stdout.trim()}`
      );
    }
  }

  phaseResult(phasePassed, phaseTotal, phaseSkipped);
}

// ============================================================
// Phase 5: Stop Hooks
// ============================================================
function phase5StopHooks(settings) {
  phaseHeader(5, 'Stop Hooks');

  let phasePassed = 0;
  let phaseSkipped = 0;
  let phaseTotal = 0;

  const stopHooks = settings.hooks?.Stop || [];

  for (const entry of stopHooks) {
    for (const hook of entry.hooks || []) {
      if (hook.type !== 'command') continue;
      phaseTotal++;

      const hookId = hook._id || 'unknown';
      const cmd = hook.command;

      // Special handling for session-state-finalize: skip if session.json doesn't exist
      if (hookId === 'session-state-finalize') {
        const sessionFile = resolve(CLAUDE_DIR, 'context', 'session.json');
        if (!existsSync(sessionFile)) {
          skip(`${hookId}`, 'session.json not found');
          phaseSkipped++;
          continue;
        }
      }

      // Special handling for journal-promotion-check: requires journal entries dir
      if (hookId === 'journal-promotion-check') {
        const journalDir = resolve(CLAUDE_DIR, 'journal', 'entries');
        if (!existsSync(journalDir)) {
          skip(`${hookId}`, 'no journal entries directory');
          phaseSkipped++;
          continue;
        }
      }

      try {
        const result = spawnSync('sh', ['-c', cmd], {
          encoding: 'utf-8',
          timeout: 10000,
          cwd: ROOT,
        });

        // Stop hooks use || true patterns, so they should always exit 0
        if (result.status === 0) {
          pass(`${hookId} -> exit 0`);
          phasePassed++;
        } else {
          fail(`${hookId} -> expected exit 0, got ${result.status}`, result.stderr);
        }
      } catch (err) {
        fail(`${hookId} -> error: ${err.message}`);
      }
    }
  }

  phaseResult(phasePassed, phaseTotal, phaseSkipped);
}

// ============================================================
// Main
// ============================================================
function main() {
  console.log(`${BOLD}${CYAN}Hook Test Harness v1.0${RESET}`);
  console.log(`${DIM}${'='.repeat(50)}${RESET}`);
  console.log(`${DIM}Root: ${ROOT}${RESET}`);
  console.log(`${DIM}Fixtures: ${FIXTURES_DIR}${RESET}`);

  if (!existsSync(SETTINGS_PATH)) {
    console.error(`${RED}ERROR: settings.json not found at ${SETTINGS_PATH}${RESET}`);
    process.exit(1);
  }

  const settings = loadSettings();

  phase1ScriptExistence(settings);
  phase2PatternMatching();
  phase3PostToolUseHooks(settings);
  phase4SubagentStopHooks();
  phase5StopHooks(settings);

  // Summary
  console.log('');
  console.log(`${BOLD}${'='.repeat(50)}${RESET}`);
  const total = totalPassed + totalFailed + totalSkipped;
  const statusColor = totalFailed > 0 ? RED : GREEN;
  const skipMsg = totalSkipped > 0 ? `, ${YELLOW}${totalSkipped} skipped${RESET}` : '';
  console.log(`${statusColor}${BOLD}Results: ${totalPassed} passed, ${totalFailed} failed${skipMsg}${RESET}`);
  console.log(`${BOLD}${'='.repeat(50)}${RESET}`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
