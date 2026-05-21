#!/usr/bin/env node

/**
 * MetaClaude CLI - Centralized artifact sync across repositories
 *
 * Commands:
 *   list                    - List configured projects
 *   status [project]        - Check for available updates
 *   sync [project]          - Push artifacts to target repos
 *   verify [project]        - Verify installed artifacts match lock file
 *   add <name> [--path=p]   - Add a project to configuration
 *   remove <name>           - Remove a project from configuration
 *   clean [project]         - Remove orphaned artifacts from target repos
 *
 * Global Options:
 *   --base-dir=<path>       - Override default base directory
 *   --force                 - Force overwrite on conflicts
 *   --resolve-conflicts     - Accept upstream version for conflicting artifacts only
 *   --no-runtime-deps       - Skip .claude/node_modules provisioning for synced hooks/scripts
 *   --no-mcp-ensure         - Skip Claude Code MCP add/get ensure checks
 *
 * Sync Overrides (per-project in projects.json):
 *   "agent-assisted"        - Stage upstream to .claude/sync-pending/ for manual merge
 *
 * Usage:
 *   node metaclaude-cli.mjs <command> [project] [options]
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { resolve, dirname, basename, join, isAbsolute } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mergeGitignore } from './lib/gitignore-merge.mjs';
import { detectOrphans } from './lib/orphan-detector.mjs';
import { validateImports } from './lib/import-graph-validator.mjs';
import { assertContainment, PathEscapeError } from './lib/path-containment.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve METACLAUDE_ROOT relative to CWD when a fixture registry is present.
// This lets the test suite spawn `metaclaude-cli.mjs` with `cwd: <tempRoot>` and
// have the script operate on the temp-dir fixture registry. Normal author use
// (invoked from any directory) falls back to the executable-relative path.
function resolveMetaclaudeRoot() {
  const cwdCandidate = resolve(process.cwd());
  if (existsSync(join(cwdCandidate, '.claude/metaclaude-registry.json'))) {
    return cwdCandidate;
  }
  return resolve(__dirname, '../..');
}
const METACLAUDE_ROOT = resolveMetaclaudeRoot();
const EXECUTABLE_ROOT = resolve(__dirname, '../..');

const SYNC_RUNTIME_PACKAGE_NAMES = Object.freeze([
  'acorn',
  'ajv',
  'ajv-formats',
  'typescript',
  'yaml',
  'zod',
]);
const SYNC_RUNTIME_TRIGGER_PATHS = new Set(['.claude/settings.json']);
const SKIP_RUNTIME_DEP_PROVISION_ENV = 'METACLAUDE_SKIP_RUNTIME_DEP_PROVISION';
const RUNTIME_DEP_INSTALL_TIMEOUT_MS = 120_000;
const PLAYWRIGHT_MCP_ARTIFACT = 'config/mcp';
const PLAYWRIGHT_MCP_SERVER_NAME = 'playwright';
const PLAYWRIGHT_MCP_ADD_ARGS = Object.freeze([
  'mcp',
  'add',
  PLAYWRIGHT_MCP_SERVER_NAME,
  '--',
  'npx',
  '@playwright/mcp@latest',
]);
const MCP_NOTIFY_SERVER_NAME = 'mcp-notify';
const MCP_NOTIFY_ENTRY_ENV = 'METACLAUDE_MCP_NOTIFY_ENTRY';
const CLAUDE_BIN_ENV = 'METACLAUDE_CLAUDE_BIN';
const SKIP_MCP_ENSURE_ENV = 'METACLAUDE_SKIP_MCP_ENSURE';
const MCP_ENSURE_TIMEOUT_MS = 60_000;

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function log(msg, color = 'reset') {
  console.error(`${colors[color]}${msg}${colors.reset}`);
}

function computeHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// ============== CONFIG LOADING ==============

function loadProjectsConfig() {
  const configPath = join(METACLAUDE_ROOT, '.claude', 'projects.json');
  const config = loadJson(configPath);
  if (!config) {
    log('No projects.json found. Run from metaclaude-assistant repo.', 'red');
    process.exit(1);
  }
  return config;
}

function loadRegistry() {
  const registryPath = join(
    METACLAUDE_ROOT,
    '.claude',
    'metaclaude-registry.json',
  );
  const registry = loadJson(registryPath);
  if (!registry) {
    log('Registry not found at .claude/metaclaude-registry.json', 'red');
    process.exit(1);
  }
  return registry;
}

function resolveProjectPath(
  projectName,
  projectConfig,
  defaults,
  options = {},
) {
  // Explicit per-project absolute path aliases (in priority order):
  //   - projectConfig.path
  //   - projectConfig.target_path (test fixture convention)
  for (const candidate of [projectConfig.path, projectConfig.target_path]) {
    if (candidate) {
      return isAbsolute(candidate)
        ? candidate
        : resolve(METACLAUDE_ROOT, candidate);
    }
  }

  // Test fixture convention: defaults.target_path points at a single consumer
  // directory (used by tmp-dir integration tests that do not have a real sibling
  // directory layout).
  if (defaults?.target_path) {
    return isAbsolute(defaults.target_path)
      ? defaults.target_path
      : resolve(METACLAUDE_ROOT, defaults.target_path);
  }

  // Use base_dir from options, defaults, or fallback to '..'
  const baseDir = options.baseDir || defaults?.base_dir || '..';
  const resolvedBase = isAbsolute(baseDir)
    ? baseDir
    : resolve(METACLAUDE_ROOT, baseDir);
  return join(resolvedBase, projectName);
}

function getLockPath(projectName, projectPath) {
  // Test-fixture convention: when projectPath is provided, look for a
  // consumer-local lock file first. Fall back to the authoritative author-side
  // lock if the consumer-local variant doesn't exist.
  if (projectPath) {
    const consumerLock = join(
      projectPath,
      '.claude',
      'locks',
      `${projectName}.lock.json`,
    );
    if (existsSync(consumerLock)) return consumerLock;
  }
  return join(METACLAUDE_ROOT, '.claude', 'locks', `${projectName}.lock.json`);
}

function resolveBundleArtifacts(registry, bundleName, resolved = new Set()) {
  const bundle = registry.bundles[bundleName];
  if (!bundle) {
    throw new Error(`Bundle not found: ${bundleName}`);
  }

  // Handle inheritance
  if (bundle.extends) {
    resolveBundleArtifacts(registry, bundle.extends, resolved);
  }

  // Add this bundle's artifacts
  for (const artifactPath of bundle.includes) {
    resolved.add(artifactPath);
  }

  return resolved;
}

function getArtifact(registry, artifactPath) {
  // Primary lookup: category.name (conventional shape)
  const [category, ...rest] = artifactPath.split('/');
  const name = rest.join('/');
  const direct = registry.artifacts[category]?.[name];
  if (direct) return direct;
  // Fallback: some test fixtures key the entry with the full compound id
  // (e.g., artifacts.scripts['scripts/example']) rather than splitting by
  // category. Support both shapes for consumer compatibility.
  return registry.artifacts[category]?.[artifactPath];
}

function getEffectiveSyncPolicy(registry, artifactPath, artifact) {
  const [category] = artifactPath.split('/');
  const categoryMeta = registry.artifacts[category];
  return artifact?._sync_policy || categoryMeta?._sync_policy;
}

function resolveTargetArtifactsForProject(registry, projectConfig, defaults) {
  const bundleName = projectConfig.bundle || defaults?.bundle;
  if (!bundleName) return null;

  const targetArtifacts = resolveBundleArtifacts(registry, bundleName);
  if (projectConfig.additional) {
    projectConfig.additional.forEach((a) => targetArtifacts.add(a));
  }
  if (projectConfig.excluded) {
    projectConfig.excluded.forEach((a) => targetArtifacts.delete(a));
  }

  return targetArtifacts;
}

function resolveInstalledTargetPath(installed) {
  return (
    installed?.target_path || installed?.targetPath || installed?.path || null
  );
}

function isProtectedArtifact(
  projectConfig,
  artifactPath,
  targetPath,
  sourcePath,
) {
  const protectedPaths = projectConfig.protected || [];
  return (
    protectedPaths.includes(artifactPath) ||
    (targetPath && protectedPaths.includes(targetPath)) ||
    (sourcePath && protectedPaths.includes(sourcePath))
  );
}

function getProjectsToProcess(config, projectArg) {
  if (projectArg) {
    if (!config.projects[projectArg]) {
      log(`Project not found: ${projectArg}`, 'red');
      log(
        `Available projects: ${Object.keys(config.projects).join(', ') || '(none)'}`,
        'dim',
      );
      process.exit(1);
    }
    return [projectArg];
  }
  return Object.keys(config.projects);
}

// ============== SETTINGS MERGE ==============

/**
 * Merge settings.json with special handling for metaclaude hooks.
 *
 * Strategy:
 * 1. If no existing target settings.json, copy source directly
 * 2. If existing file:
 *    - Remove hooks with _source: "metaclaude" from target
 *    - Add all hooks from source (which have _source: "metaclaude")
 *    - Preserve project-specific hooks (those without _source field)
 *
 * @param {string} sourceContent - Source settings.json content
 * @param {string} targetPath - Path to target settings.json
 * @returns {{ merged: string, report: string[] }} Merged content and report messages
 */
function mergeSettings(sourceContent, targetPath) {
  const report = [];
  const source = JSON.parse(sourceContent);

  // If target doesn't exist, just use source
  if (!existsSync(targetPath)) {
    report.push('No existing settings.json, using source directly');
    return { merged: JSON.stringify(source, null, 2) + '\n', report };
  }

  const targetContent = readFileSync(targetPath, 'utf-8');
  let target;
  try {
    target = JSON.parse(targetContent);
  } catch (e) {
    report.push('Warning: Target settings.json has invalid JSON, overwriting');
    return { merged: JSON.stringify(source, null, 2) + '\n', report };
  }

  // Merge hooks section — build fresh object to enforce source key order
  const existingTargetHooks = target.hooks || {};
  const mergedHooks = {};

  // Process each hook type (PostToolUse, Stop, etc.)
  for (const hookType of Object.keys(source.hooks || {})) {
    const sourceHookGroups = source.hooks[hookType] || [];
    const targetHookGroups = existingTargetHooks[hookType] || [];

    // Build new hook groups array
    const mergedHookGroups = [];

    for (const sourceGroup of sourceHookGroups) {
      const matcher = sourceGroup.matcher || '*';

      // Find matching group in target (same matcher)
      let targetGroup = targetHookGroups.find(
        (g) => (g.matcher || '*') === matcher,
      );

      if (!targetGroup) {
        // No matching group in target, use source group directly (excluding _sync: false hooks)
        const syncableHooks = (sourceGroup.hooks || []).filter(
          (h) => h._sync !== false,
        );
        mergedHookGroups.push({ ...sourceGroup, hooks: syncableHooks });
        report.push(`  Added hook group [${hookType}] matcher="${matcher}"`);
      } else {
        // Merge hooks within the group
        const targetHooks = targetGroup.hooks || [];
        const sourceHooks = sourceGroup.hooks || [];

        // Remove metaclaude hooks from target
        const projectHooks = targetHooks.filter(
          (h) => h._source !== 'metaclaude',
        );
        const removedCount = targetHooks.length - projectHooks.length;
        if (removedCount > 0) {
          report.push(
            `  Removed ${removedCount} existing metaclaude hooks from [${hookType}] matcher="${matcher}"`,
          );
        }

        // Add all source hooks (all have _source: "metaclaude"), excluding _sync: false hooks
        const metaclaudeHooks = sourceHooks.filter(
          (h) => h._source === 'metaclaude' && h._sync !== false,
        );

        if (projectHooks.length > 0) {
          report.push(
            `  Preserved ${projectHooks.length} project-specific hooks in [${hookType}] matcher="${matcher}"`,
          );
        }
        report.push(
          `  Added ${metaclaudeHooks.length} metaclaude hooks to [${hookType}] matcher="${matcher}"`,
        );

        mergedHookGroups.push({
          ...sourceGroup,
          hooks: [...metaclaudeHooks, ...projectHooks],
        });
      }
    }

    // Also preserve any target hook groups that don't exist in source
    for (const targetGroup of targetHookGroups) {
      const matcher = targetGroup.matcher || '*';
      const existsInSource = sourceHookGroups.some(
        (g) => (g.matcher || '*') === matcher,
      );

      if (!existsInSource) {
        // This is a project-specific hook group, preserve it
        // But still filter out any metaclaude hooks that may have been added previously
        const projectHooks = (targetGroup.hooks || []).filter(
          (h) => h._source !== 'metaclaude',
        );
        if (projectHooks.length > 0) {
          mergedHookGroups.push({
            ...targetGroup,
            hooks: projectHooks,
          });
          report.push(
            `  Preserved project hook group [${hookType}] matcher="${matcher}" (${projectHooks.length} hooks)`,
          );
        }
      }
    }

    mergedHooks[hookType] = mergedHookGroups;
  }

  // Preserve any target-only hook types (not in source) at the end
  for (const hookType of Object.keys(existingTargetHooks)) {
    if (!mergedHooks[hookType]) {
      mergedHooks[hookType] = existingTargetHooks[hookType];
    }
  }

  target.hooks = mergedHooks;

  return { merged: JSON.stringify(target, null, 2) + '\n', report };
}

// ============== COMMANDS ==============

async function cmdList() {
  const config = loadProjectsConfig();
  const projects = Object.keys(config.projects);

  log('\nConfigured Projects', 'cyan');
  log('='.repeat(50));

  if (projects.length === 0) {
    log('No projects configured. Use: metaclaude add <name>', 'dim');
    return;
  }

  for (const name of projects) {
    const proj = config.projects[name];
    const path = resolveProjectPath(name, proj, config.defaults);
    const exists = existsSync(path);
    const bundle = proj.bundle || config.defaults?.bundle || '(none)';

    const statusIcon = exists ? colors.green + '✓' : colors.red + '✗';
    log(`${statusIcon}${colors.reset} ${name}`);
    log(`    Path: ${path}`, 'dim');
    log(`    Bundle: ${bundle}`, 'dim');
  }
  log('');
}

async function cmdStatus(projectArg, options) {
  const config = loadProjectsConfig();
  const registry = loadRegistry();
  const projects = getProjectsToProcess(config, projectArg);

  for (const projectName of projects) {
    const projectConfig = config.projects[projectName];
    const projectPath = resolveProjectPath(
      projectName,
      projectConfig,
      config.defaults,
      options,
    );
    const lockPath = getLockPath(projectName, projectPath);
    const lock = loadJson(lockPath) || { installed: {} };

    log(`\n${colors.bold}${projectName}${colors.reset}`, 'cyan');
    log(`Path: ${projectPath}`, 'dim');
    log('='.repeat(50));

    if (!existsSync(projectPath)) {
      log('Project directory does not exist', 'yellow');
      continue;
    }

    // Resolve what should be installed
    const bundleName = projectConfig.bundle || config.defaults?.bundle;
    if (!bundleName) {
      log('No bundle specified', 'yellow');
      continue;
    }

    const targetArtifacts = resolveTargetArtifactsForProject(
      registry,
      projectConfig,
      config.defaults,
    );

    let updatesAvailable = 0;
    let missing = 0;
    let current = 0;
    let modified = 0;
    let agentAssisted = 0;
    let deletionsPending = 0;
    let deletionConflicts = 0;
    let obsoleteLocks = 0;

    for (const artifactPath of [...targetArtifacts].sort()) {
      const artifact = getArtifact(registry, artifactPath);
      if (!artifact) {
        log(`? ${artifactPath} - not found in registry`, 'yellow');
        continue;
      }

      // Show agent-assisted artifacts with distinct indicator
      const [statusCategory] = artifactPath.split('/');
      const statusCategoryMeta = registry.artifacts[statusCategory];
      const statusEffectivePolicy =
        artifact._sync_policy || statusCategoryMeta?._sync_policy;
      const statusIsAgentAssisted =
        projectConfig.sync_overrides?.[artifactPath] === 'agent-assisted' ||
        statusEffectivePolicy === 'agent-assisted';
      if (statusIsAgentAssisted) {
        const installed = lock.installed[artifactPath];
        const hasUpdate = installed ? installed.hash !== artifact.hash : true;
        if (hasUpdate) {
          log(
            `⊕ ${artifactPath}: ${artifact.version}@${artifact.hash} (agent-assisted merge needed)`,
            'cyan',
          );
          agentAssisted++;
        } else {
          log(
            `⊕ ${artifactPath}: ${artifact.version}@${artifact.hash} (agent-assisted, up to date)`,
            'dim',
          );
          current++;
        }
        continue;
      }

      const installed = lock.installed[artifactPath];
      const targetPath = artifact.target_path || artifact.path;
      const localPath = join(projectPath, targetPath);
      const localExists = existsSync(localPath);
      const statusIsNeverOverwrite =
        statusEffectivePolicy === 'never-overwrite';

      if (statusIsNeverOverwrite && localExists) {
        log(
          `↷ ${artifactPath}: ${artifact.version}@${artifact.hash} (never-overwrite, local file exists)`,
          'dim',
        );
        current++;
        continue;
      }

      if (!installed && !localExists) {
        log(
          `+ ${artifactPath}: ${artifact.version}@${artifact.hash} (not installed)`,
          'yellow',
        );
        missing++;
      } else if (!installed && localExists) {
        const localHash = computeHash(readFileSync(localPath, 'utf-8'));
        if (localHash === artifact.hash) {
          log(
            `= ${artifactPath}: ${artifact.version}@${artifact.hash} (unlocked but matches)`,
            'dim',
          );
          current++;
        } else {
          log(`~ ${artifactPath}: local differs from upstream`, 'yellow');
          modified++;
        }
      } else if (installed.hash !== artifact.hash) {
        log(
          `↑ ${artifactPath}: ${installed.version}@${installed.hash} → ${artifact.version}@${artifact.hash}`,
          'green',
        );
        updatesAvailable++;
      } else {
        // Check for local modifications
        if (localExists) {
          const localHash = computeHash(readFileSync(localPath, 'utf-8'));
          if (localHash !== installed.hash) {
            if (
              artifact.merge_strategy === 'settings-merge' ||
              artifact.merge_strategy === 'gitignore-merge'
            ) {
              log(
                `  ${artifactPath}: ${artifact.version}@${artifact.hash} (merged)`,
                'dim',
              );
              // Don't increment modified count - merge-strategy artifacts are expected to differ
            } else {
              log(
                `* ${artifactPath}: ${artifact.version}@${artifact.hash} (locally modified)`,
                'yellow',
              );
              modified++;
            }
          } else {
            log(
              `✓ ${artifactPath}: ${artifact.version}@${artifact.hash}`,
              'dim',
            );
            current++;
          }
        } else {
          log(`! ${artifactPath}: locked but missing locally`, 'red');
          missing++;
        }
      }
    }

    for (const [artifactPath, installed] of Object.entries(
      lock.installed || {},
    ).sort()) {
      if (targetArtifacts.has(artifactPath)) continue;

      const targetPath = resolveInstalledTargetPath(installed);
      if (!targetPath) {
        log(
          `- ${artifactPath}: obsolete lock entry (no target path recorded)`,
          'yellow',
        );
        obsoleteLocks++;
        continue;
      }

      const localPath = join(projectPath, targetPath);
      if (!existsSync(localPath)) {
        log(
          `- ${artifactPath}: obsolete lock entry (file already absent)`,
          'dim',
        );
        obsoleteLocks++;
        continue;
      }

      const localHash = computeHash(readFileSync(localPath, 'utf-8'));
      if (installed.hash && localHash === installed.hash) {
        log(
          `- ${artifactPath}: no longer targeted (deletion pending)`,
          'yellow',
        );
        deletionsPending++;
      } else {
        log(
          `! ${artifactPath}: no longer targeted but locally modified`,
          'yellow',
        );
        deletionConflicts++;
      }
    }

    log('');
    const agentMsg =
      agentAssisted > 0 ? `, ${agentAssisted} agent-assisted` : '';
    const deletionMsg =
      deletionsPending > 0 ? `, ${deletionsPending} deletion pending` : '';
    const deletionConflictMsg =
      deletionConflicts > 0 ? `, ${deletionConflicts} deletion conflict` : '';
    const obsoleteMsg =
      obsoleteLocks > 0 ? `, ${obsoleteLocks} obsolete lock` : '';
    log(
      `Summary: ${current} current, ${updatesAvailable} updates, ${missing} missing, ${modified} modified${agentMsg}${deletionMsg}${deletionConflictMsg}${obsoleteMsg}`,
    );
  }

  log('');
}

/**
 * Sync-time drift warning (sg-sync-registry-gaps T2.11, REQ-014, AC-14.1).
 *
 * Runs the orphan detector and import-graph validator in WARN-ONLY mode before the
 * sync walk. Findings are printed to stderr as `WARNING:` JSON lines. The process
 * exits 0 regardless -- the gates are advisory on the consumer side per the
 * two-tier asymmetric enforcement pattern.
 *
 * @param {object} registry - Parsed registry
 * @returns {number} total finding count (for summary purposes only)
 */
function emitSyncTimeDriftWarnings(registry) {
  let findings = [];
  try {
    const orph = detectOrphans(registry, METACLAUDE_ROOT);
    findings = findings.concat(orph.findings);
  } catch (err) {
    // Fail-open: a broken detector must not strand the consumer.
    log(`WARNING: sync drift detector failed: ${err.message}`, 'yellow');
  }
  try {
    const imp = validateImports(registry, METACLAUDE_ROOT);
    findings = findings.concat(imp.findings);
  } catch (err) {
    log(
      `WARNING: sync import-graph validator failed: ${err.message}`,
      'yellow',
    );
  }
  for (const f of findings) {
    console.error(`WARNING: ${JSON.stringify(f)}`);
  }
  return findings.length;
}

/**
 * TOCTOU-safe containment re-check performed immediately before a sync read.
 *
 * AC-16.1, AC-17.3. Returns `true` when the realpath of `sourceFile` still lies
 * within `claudeRoot`. On escape or ENOENT, emits a toctou-containment finding to
 * stderr and returns `false`. The caller skips the artifact on false.
 *
 * @param {string} sourceFile - Absolute path the sync is about to read
 * @param {string} artifactPath - Registry artifact id (for finding metadata)
 * @returns {boolean} true if safe to read
 */
function syncTimeContainmentOk(sourceFile, artifactPath) {
  const claudeRoot = resolve(METACLAUDE_ROOT, '.claude');
  try {
    assertContainment(sourceFile, claudeRoot);
    return true;
  } catch (err) {
    const finding = {
      rule: 'toctou-containment',
      file: artifactPath,
      bundle: null,
      importer: null,
      missingImport: null,
      target: sourceFile,
      message:
        err instanceof PathEscapeError
          ? `Sync-time containment re-check failed: ${err.message}`
          : `Sync-time read aborted: ${err.message}`,
      remediation:
        'Investigate filesystem state; the source file changed or became a symlink between compute and sync',
    };
    console.error(`WARNING: ${JSON.stringify(finding)}`);
    return false;
  }
}

/**
 * Pre-flight manifest shape validation (sg-enforcement-layer-gaps Task 14 /
 * REQ-M1-009 / AC-7.1, AC-7.2, AC-7.3).
 *
 * For a given consumer project directory, discovers
 * `.claude/specs/groups/*\/manifest.json` and runs the main-repo's
 * `validate-manifest.mjs` (strict shape-lint) against each. Returns
 * `{ blocked: boolean, offenders: string[] }`.
 *
 * Behavior: invalid consumer-local manifests are surfaced as warning-only
 * diagnostics. Shared artifact propagation must not be stranded by unrelated
 * in-flight spec cleanup in the consumer repo. The pre-flight is
 * NON-destructive — it never writes to the consumer.
 *
 * Graceful degradation:
 *   - If the consumer has no `specs/groups/` directory, skip (empty corpus =
 *     legal state for a freshly-added consumer).
 *   - If the main-repo validator script is missing (shouldn't happen post-sync
 *     but we defensively guard), log a warning and pass through (fail-open on
 *     internal config error rather than stranding the consumer).
 */
function preflightValidateConsumerManifests(projectPath) {
  const specsGroupsDir = join(projectPath, '.claude', 'specs', 'groups');
  if (!existsSync(specsGroupsDir)) {
    return { blocked: false, offenders: [], scanned: 0 };
  }
  const validatorPath = join(
    METACLAUDE_ROOT,
    '.claude',
    'scripts',
    'validate-manifest.mjs',
  );
  if (!existsSync(validatorPath)) {
    log(
      `  Pre-flight skipped: validator script not found at ${validatorPath}`,
      'yellow',
    );
    return { blocked: false, offenders: [], scanned: 0 };
  }

  let manifestPaths = [];
  try {
    const groups = readdirSync(specsGroupsDir, { withFileTypes: true });
    for (const g of groups) {
      if (!g.isDirectory()) continue;
      const mp = join(specsGroupsDir, g.name, 'manifest.json');
      if (existsSync(mp)) manifestPaths.push(mp);
    }
  } catch (err) {
    log(
      `  Pre-flight error reading consumer manifests: ${err.message}`,
      'yellow',
    );
    return { blocked: false, offenders: [], scanned: 0 };
  }

  if (manifestPaths.length === 0) {
    return { blocked: false, offenders: [], scanned: 0 };
  }

  const offenders = [];
  for (const mp of manifestPaths) {
    const r = spawnSync('node', [validatorPath, mp], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      offenders.push(mp);
      if (r.stderr) {
        // Surface first few lines of validator output for operator context.
        const lines = r.stderr
          .split('\n')
          .filter((l) => l.length > 0)
          .slice(0, 4);
        for (const line of lines) log(`    ${line}`, 'red');
      }
    }
  }

  return {
    blocked: offenders.length > 0,
    offenders,
    scanned: manifestPaths.length,
  };
}

function packageDir(nodeModulesRoot, packageName) {
  return join(nodeModulesRoot, ...packageName.split('/'));
}

function packageIsPresent(nodeModulesRoot, packageName) {
  return existsSync(
    join(packageDir(nodeModulesRoot, packageName), 'package.json'),
  );
}

function tryLstat(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function sortedObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function loadRuntimeDependencyVersions() {
  const packageJsonCandidates = [
    join(METACLAUDE_ROOT, 'package.json'),
    join(EXECUTABLE_ROOT, 'package.json'),
  ];
  const seen = new Set();

  for (const candidate of packageJsonCandidates) {
    if (seen.has(candidate) || !existsSync(candidate)) continue;
    seen.add(candidate);

    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
      const sections = [
        pkg.dependencies || {},
        pkg.devDependencies || {},
        pkg.optionalDependencies || {},
      ];
      const deps = {};
      const missing = [];
      for (const packageName of SYNC_RUNTIME_PACKAGE_NAMES) {
        const version = sections.map((s) => s[packageName]).find(Boolean);
        if (version) {
          deps[packageName] = version;
        } else {
          missing.push(packageName);
        }
      }
      if (missing.length === 0) {
        return { deps: sortedObject(deps), source: candidate, missing };
      }
    } catch {
      // Try the next candidate; sync should not fail because a fallback package
      // manifest is malformed or absent in a test fixture.
    }
  }

  return {
    deps: sortedObject(
      Object.fromEntries(SYNC_RUNTIME_PACKAGE_NAMES.map((name) => [name, '*'])),
    ),
    source: null,
    missing: [...SYNC_RUNTIME_PACKAGE_NAMES],
  };
}

function findRuntimeDependencySourceRoot() {
  const candidates = [
    join(METACLAUDE_ROOT, 'node_modules'),
    join(EXECUTABLE_ROOT, 'node_modules'),
  ];
  const seen = new Set();

  for (const candidate of candidates) {
    if (seen.has(candidate) || !existsSync(candidate)) continue;
    seen.add(candidate);
    if (
      SYNC_RUNTIME_PACKAGE_NAMES.every((name) =>
        packageIsPresent(candidate, name),
      )
    ) {
      return candidate;
    }
  }
  return null;
}

function writeRuntimeDependencyManifest(projectPath, deps) {
  const runtimeDir = join(projectPath, '.claude');
  const manifestPath = join(runtimeDir, 'package.json');
  mkdirSync(runtimeDir, { recursive: true });

  let manifest = {};
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      manifest = {};
    }
  }

  const next = {
    ...manifest,
    name: manifest.name || 'metaclaude-consumer-runtime',
    private: true,
    type: 'module',
    dependencies: sortedObject({
      ...(manifest.dependencies || {}),
      ...deps,
    }),
  };
  const nextContent = JSON.stringify(next, null, 2) + '\n';
  const currentContent = existsSync(manifestPath)
    ? readFileSync(manifestPath, 'utf-8')
    : null;
  if (currentContent !== nextContent) {
    writeFileSync(manifestPath, nextContent);
    return { changed: true, manifestPath };
  }
  return { changed: false, manifestPath };
}

function linkRuntimeDependencyPackages(projectPath, sourceNodeModulesRoot) {
  const targetNodeModulesRoot = join(projectPath, '.claude', 'node_modules');
  mkdirSync(targetNodeModulesRoot, { recursive: true });

  let linked = 0;
  let present = 0;
  const skipped = [];

  for (const packageName of SYNC_RUNTIME_PACKAGE_NAMES) {
    const sourcePackageDir = packageDir(sourceNodeModulesRoot, packageName);
    const targetPackageDir = packageDir(targetNodeModulesRoot, packageName);
    const stat = tryLstat(targetPackageDir);

    if (stat && existsSync(join(targetPackageDir, 'package.json'))) {
      if (stat.isSymbolicLink()) {
        const sourceReal = realpathSync(sourcePackageDir);
        const targetReal = realpathSync(targetPackageDir);
        if (sourceReal === targetReal) {
          present++;
          continue;
        }
        rmSync(targetPackageDir, { recursive: true, force: true });
      } else {
        present++;
        continue;
      }
    } else if (stat?.isSymbolicLink()) {
      rmSync(targetPackageDir, { recursive: true, force: true });
    } else if (stat) {
      skipped.push(packageName);
      continue;
    }

    mkdirSync(dirname(targetPackageDir), { recursive: true });
    symlinkSync(sourcePackageDir, targetPackageDir, 'dir');
    linked++;
  }

  return { status: 'linked', linked, present, skipped, sourceNodeModulesRoot };
}

function installRuntimeDependencyPackages(projectPath, deps) {
  const runtimeDir = join(projectPath, '.claude');
  const targetNodeModulesRoot = join(runtimeDir, 'node_modules');
  const { changed } = writeRuntimeDependencyManifest(projectPath, deps);

  const missing = SYNC_RUNTIME_PACKAGE_NAMES.filter(
    (name) => !packageIsPresent(targetNodeModulesRoot, name),
  );
  if (!changed && missing.length === 0) {
    return { status: 'current' };
  }

  const result = spawnSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: runtimeDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: RUNTIME_DEP_INSTALL_TIMEOUT_MS,
    },
  );

  if (result.error) {
    return { status: 'failed', error: result.error.message };
  }
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '')
      .split('\n')
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');
    return {
      status: 'failed',
      error: details || `npm exited ${result.status}`,
    };
  }
  return { status: 'installed', missing };
}

function shouldProvisionRuntimeDeps(registry, targetArtifacts) {
  for (const artifactPath of targetArtifacts) {
    const artifact = getArtifact(registry, artifactPath);
    const sourcePath = artifact?.path || '';
    if (
      sourcePath.startsWith('.claude/scripts/') ||
      SYNC_RUNTIME_TRIGGER_PATHS.has(sourcePath)
    ) {
      return true;
    }
  }
  return false;
}

function ensureConsumerRuntimeDependencies(
  projectPath,
  registry,
  targetArtifacts,
  options = {},
) {
  try {
    const skipFromEnv = /^(1|true|yes)$/i.test(
      process.env[SKIP_RUNTIME_DEP_PROVISION_ENV] || '',
    );
    if (options.runtimeDeps === false || skipFromEnv) {
      return { status: 'skipped' };
    }
    if (!shouldProvisionRuntimeDeps(registry, targetArtifacts)) {
      return { status: 'not-needed' };
    }

    const { deps } = loadRuntimeDependencyVersions();
    const sourceNodeModulesRoot = findRuntimeDependencySourceRoot();
    if (sourceNodeModulesRoot) {
      writeRuntimeDependencyManifest(projectPath, deps);
      try {
        return linkRuntimeDependencyPackages(
          projectPath,
          sourceNodeModulesRoot,
        );
      } catch (err) {
        const installResult = installRuntimeDependencyPackages(
          projectPath,
          deps,
        );
        if (installResult.status === 'failed') {
          return {
            status: 'failed',
            error: `link failed (${err.message}); install failed (${installResult.error})`,
          };
        }
        return installResult;
      }
    }

    return installRuntimeDependencyPackages(projectPath, deps);
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
}

function logRuntimeDependencyResult(result) {
  if (!result || result.status === 'not-needed') return;
  if (result.status === 'skipped') {
    log(
      `  Runtime deps: skipped (${SKIP_RUNTIME_DEP_PROVISION_ENV}=1 or --no-runtime-deps)`,
      'dim',
    );
    return;
  }
  if (result.status === 'current') {
    log('  Runtime deps: already available in .claude/node_modules', 'dim');
    return;
  }
  if (result.status === 'linked') {
    const skipMsg =
      result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : '';
    log(
      `  Runtime deps: ${result.linked} linked, ${result.present} present${skipMsg} in .claude/node_modules`,
      result.skipped.length > 0 ? 'yellow' : 'green',
    );
    if (result.skipped.length > 0) {
      log(
        `    Skipped existing non-package paths: ${result.skipped.join(', ')}`,
        'yellow',
      );
    }
    return;
  }
  if (result.status === 'installed') {
    log('  Runtime deps: installed into .claude/node_modules', 'green');
    return;
  }
  if (result.status === 'failed') {
    log(`  Runtime deps warning: ${result.error}`, 'yellow');
    log(
      '    Hooks may fail until dependencies are installed; rerun sync after installing npm dependencies.',
      'dim',
    );
  }
}

function projectMcpJsonHasServer(projectPath, serverName) {
  const mcpJsonPath = join(projectPath, '.mcp.json');
  if (!existsSync(mcpJsonPath)) return false;

  try {
    const data = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    return Boolean(data?.mcpServers?.[serverName]);
  } catch {
    return false;
  }
}

function getMcpNotifyEntryPath() {
  return (
    process.env[MCP_NOTIFY_ENTRY_ENV] ||
    join(METACLAUDE_ROOT, '..', MCP_NOTIFY_SERVER_NAME, 'dist', 'index.js')
  );
}

function getMcpEnsureDefinitions() {
  const notifyEntry = getMcpNotifyEntryPath();
  return [
    {
      name: PLAYWRIGHT_MCP_SERVER_NAME,
      addArgs: PLAYWRIGHT_MCP_ADD_ARGS,
      commandDisplay: 'claude mcp add playwright -- npx @playwright/mcp@latest',
      targetArtifact: PLAYWRIGHT_MCP_ARTIFACT,
      skipWhenProtected: true,
      protectedTargetPath: '.mcp.json',
      protectedSourcePath: '.claude/templates/mcp.json',
    },
    {
      name: MCP_NOTIFY_SERVER_NAME,
      addArgs: [
        'mcp',
        'add',
        MCP_NOTIFY_SERVER_NAME,
        '--',
        'node',
        notifyEntry,
      ],
      commandDisplay: `claude mcp add ${MCP_NOTIFY_SERVER_NAME} -- node ${notifyEntry}`,
      requiredPath: notifyEntry,
    },
  ];
}

function claudeMcpGetServer(projectPath, serverName) {
  const claudeBin = process.env[CLAUDE_BIN_ENV] || 'claude';
  const result = spawnSync(claudeBin, ['mcp', 'get', serverName], {
    cwd: projectPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: MCP_ENSURE_TIMEOUT_MS,
  });

  if (result.error) {
    return { exists: false, error: result.error.message };
  }
  return { exists: result.status === 0 };
}

function ensureConsumerMcpServer(
  definition,
  projectPath,
  projectConfig,
  targetArtifacts,
) {
  if (
    definition.targetArtifact &&
    !targetArtifacts.has(definition.targetArtifact)
  ) {
    return { status: 'not-needed' };
  }

  if (definition.requiredPath && !existsSync(definition.requiredPath)) {
    return {
      status: 'failed',
      name: definition.name,
      error: `required MCP entry not found: ${definition.requiredPath}`,
    };
  }

  if (
    definition.skipWhenProtected &&
    isProtectedArtifact(
      projectConfig,
      definition.targetArtifact,
      definition.protectedTargetPath,
      definition.protectedSourcePath,
    )
  ) {
    return { status: 'protected', name: definition.name };
  }

  if (projectMcpJsonHasServer(projectPath, definition.name)) {
    return { status: 'current', name: definition.name, source: '.mcp.json' };
  }

  const existing = claudeMcpGetServer(projectPath, definition.name);
  if (existing.exists) {
    return {
      status: 'current',
      name: definition.name,
      source: 'claude-local-config',
    };
  }

  const claudeBin = process.env[CLAUDE_BIN_ENV] || 'claude';
  const result = spawnSync(claudeBin, definition.addArgs, {
    cwd: projectPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: MCP_ENSURE_TIMEOUT_MS,
  });

  if (result.error) {
    return {
      status: 'failed',
      name: definition.name,
      error: result.error.message,
    };
  }
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '')
      .split('\n')
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');
    return {
      status: 'failed',
      name: definition.name,
      error: details || `claude exited ${result.status}`,
    };
  }

  return {
    status: 'installed',
    name: definition.name,
    commandDisplay: definition.commandDisplay,
  };
}

function ensureConsumerMcpServers(
  projectPath,
  projectConfig,
  targetArtifacts,
  options = {},
) {
  const skipFromEnv = /^(1|true|yes)$/i.test(
    process.env[SKIP_MCP_ENSURE_ENV] || '',
  );
  if (options.mcpEnsure === false || skipFromEnv) {
    return [{ status: 'skipped' }];
  }

  return getMcpEnsureDefinitions().map((definition) =>
    ensureConsumerMcpServer(
      definition,
      projectPath,
      projectConfig,
      targetArtifacts,
    ),
  );
}

function logMcpEnsureResults(results) {
  if (!Array.isArray(results)) return;
  for (const result of results) {
    if (!result || result.status === 'not-needed') continue;
    if (result.status === 'skipped') {
      log(
        `  MCP ensure: skipped (${SKIP_MCP_ENSURE_ENV}=1 or --no-mcp-ensure)`,
        'dim',
      );
      continue;
    }
    if (result.status === 'protected') {
      log(`  MCP ${result.name}: skipped (.mcp.json is protected)`, 'dim');
      continue;
    }
    if (result.status === 'current') {
      log(
        `  MCP ${result.name}: already configured via ${result.source}`,
        'dim',
      );
      continue;
    }
    if (result.status === 'installed') {
      log(
        `  MCP ${result.name}: installed via \`${result.commandDisplay}\``,
        'green',
      );
      continue;
    }
    if (result.status === 'failed') {
      log(`  MCP ${result.name} warning: ${result.error}`, 'yellow');
      log(
        '    Run the logged `claude mcp add ...` command from the consumer project.',
        'dim',
      );
    }
  }
}

async function cmdSync(projectArg, options) {
  const config = loadProjectsConfig();
  const registry = loadRegistry();
  const projects = getProjectsToProcess(config, projectArg);

  // T2.11: emit drift warnings once for the whole sync run (not per consumer).
  // Warn-only: findings printed, process continues.
  const driftCount = emitSyncTimeDriftWarnings(registry);
  if (driftCount > 0) {
    log(
      `\nWARNING: ${driftCount} registry drift finding(s) detected (warn-only)`,
      'yellow',
    );
  }

  for (const projectName of projects) {
    const projectConfig = config.projects[projectName];
    const projectPath = resolveProjectPath(
      projectName,
      projectConfig,
      config.defaults,
      options,
    );
    const lockPath = getLockPath(projectName, projectPath);

    log(`\n${colors.bold}Syncing: ${projectName}${colors.reset}`, 'cyan');
    log(`Target: ${projectPath}`, 'dim');

    if (!existsSync(projectPath)) {
      // Structured marker (sg-sync-registry-gaps cr-propagation-a4b79e12):
      // Downstream tools (rollout-resync.mjs) match `[SYNC:target-missing] <path>`
      // in stderr instead of parsing the human-readable log line. Rewording the
      // human message must not break failure detection.
      log(`[SYNC:target-missing] ${projectPath}`, 'red');
      log(`Project directory does not exist: ${projectPath}`, 'red');
      log('Create the directory or update the path in projects.json', 'dim');
      continue;
    }

    // sg-enforcement-layer-gaps Task 14 / AC-7.1, AC-7.2, AC-7.3 — pre-flight
    // manifest-shape-lint of the consumer's own spec-group manifests BEFORE
    // pushing artifacts. This is warning-only: consumer-local spec cleanup
    // should not block propagation of shared agents/scripts/docs.
    const preflight = preflightValidateConsumerManifests(projectPath);
    if (preflight.blocked) {
      log(
        `  [SYNC:manifest-preflight-warning] ${projectPath} has ${preflight.offenders.length}/${preflight.scanned} invalid manifests; continuing sync`,
        'yellow',
      );
      log(
        '  Remediation: clean consumer manifests separately; start with `node .claude/scripts/migrate-manifest.mjs --all`,',
        'dim',
      );
      log(
        '  then manually fix remaining schema enum/path/extra-field errors.',
        'dim',
      );
      for (const offender of preflight.offenders) {
        log(`    offender: ${offender}`, 'dim');
      }
    }

    const lock = loadJson(lockPath) || {
      lock_version: '1.0.0',
      project: projectName,
      synced_at: null,
      registry_version: registry.registry_version,
      installed: {},
    };

    // Resolve target artifacts
    const bundleName = projectConfig.bundle || config.defaults?.bundle;
    if (!bundleName) {
      log('No bundle specified, skipping', 'yellow');
      continue;
    }

    const targetArtifacts = resolveTargetArtifactsForProject(
      registry,
      projectConfig,
      config.defaults,
    );
    const mcpEnsureResults = ensureConsumerMcpServers(
      projectPath,
      projectConfig,
      targetArtifacts,
      options,
    );

    log(`Syncing ${targetArtifacts.size} artifacts...`);

    let synced = 0;
    let skipped = 0;
    let conflicts = 0;
    let resolved = 0;
    const pendingMerges = [];

    for (const artifactPath of [...targetArtifacts].sort()) {
      const artifact = getArtifact(registry, artifactPath);
      if (!artifact) continue;

      const sourceFile = join(METACLAUDE_ROOT, artifact.path);
      const targetPath = artifact.target_path || artifact.path;
      const targetFile = join(projectPath, targetPath);

      if (!existsSync(sourceFile)) {
        log(`  Skip ${artifactPath}: source not found`, 'yellow');
        skipped++;
        continue;
      }

      // Check if protected
      if (
        isProtectedArtifact(
          projectConfig,
          artifactPath,
          targetPath,
          artifact.path,
        )
      ) {
        log(`  Skip ${artifactPath}: protected`, 'dim');
        skipped++;
        continue;
      }

      // Check sync policies (category-level and per-artifact)
      const [category] = artifactPath.split('/');
      const categoryMeta = registry.artifacts[category];
      const effectivePolicy =
        artifact._sync_policy || categoryMeta?._sync_policy;

      // DEC-002: never-sync means never propagate to consumer projects at all
      if (effectivePolicy === 'never-sync') {
        log(
          `  Skip ${artifactPath}: never-sync policy (excluded from sync)`,
          'dim',
        );
        skipped++;
        continue;
      }

      // never-overwrite means propagate once, then do not overwrite if target exists.
      // sg-sync-registry-gaps T2.12, AC-15.1/15.2: on hash divergence, emit a
      // shadow-file divergence warning. --ack-drift advances the lock hash but
      // never touches the consumer file.
      if (effectivePolicy === 'never-overwrite' && existsSync(targetFile)) {
        const srcContent = readFileSync(sourceFile, 'utf-8');
        const srcHash = computeHash(srcContent);
        const localHash = computeHash(readFileSync(targetFile, 'utf-8'));
        if (srcHash !== localHash) {
          if (options.ackDrift) {
            // Advance lock hash; leave consumer file untouched.
            lock.installed[artifactPath] = {
              version: artifact.version,
              hash: srcHash,
              path: artifact.path,
              installed_at: new Date().toISOString(),
            };
            log(
              `  ⊕ ${artifactPath}: shadow-file divergence acknowledged (lock advanced, file unchanged)`,
              'cyan',
            );
            skipped++;
            continue;
          }
          console.error(
            `WARNING: ${JSON.stringify({
              rule: 'provenance-invalid',
              file: artifactPath,
              bundle: null,
              importer: null,
              missingImport: null,
              target: targetPath,
              message: `shadow-file divergence: never-overwrite artifact ${artifactPath} has diverged from registry (${srcHash} vs ${localHash})`,
              remediation:
                'Review the local file; rerun sync with --ack-drift to advance the lock without overwriting',
            })}`,
          );
        }
        log(
          `  Skip ${artifactPath}: never-overwrite policy (file exists)`,
          'dim',
        );
        skipped++;
        continue;
      }

      // Check for agent-assisted policy (per-project override OR registry-level)
      const isAgentAssisted =
        projectConfig.sync_overrides?.[artifactPath] === 'agent-assisted' ||
        (effectivePolicy === 'agent-assisted' && existsSync(targetFile));
      if (isAgentAssisted) {
        const srcContent = readFileSync(sourceFile, 'utf-8');
        const srcHash = computeHash(srcContent);
        const installed = lock.installed[artifactPath];

        // Skip if upstream hasn't changed since last sync
        if (installed && installed.hash === srcHash) {
          log(
            `  Skip ${artifactPath}: agent-assisted (no upstream changes)`,
            'dim',
          );
          skipped++;
          continue;
        }

        // Stage upstream version for agent-assisted merge
        const pendingDir = join(projectPath, '.claude', 'sync-pending');
        const pendingFile = join(pendingDir, targetPath);
        mkdirSync(dirname(pendingFile), { recursive: true });
        copyFileSync(sourceFile, pendingFile);

        // Update lock to record we've "seen" this upstream version
        lock.installed[artifactPath] = {
          version: artifact.version,
          hash: srcHash,
          path: artifact.path,
          installed_at: new Date().toISOString(),
        };

        pendingMerges.push({
          artifact: artifactPath,
          upstream: join('.claude', 'sync-pending', targetPath),
          local: targetPath,
          version: artifact.version,
          hash: srcHash,
        });

        log(`  ⊕ ${artifactPath}: staged for agent-assisted merge`, 'cyan');
        continue;
      }

      // sg-sync-registry-gaps T3.1, REQ-016, AC-16.1: sync-time TOCTOU
      // re-validation. Immediately before reading the source file, re-run
      // realpath + containment. A symlink replacement between compute and sync
      // aborts this artifact (the loop continues with the next).
      if (!syncTimeContainmentOk(sourceFile, artifactPath)) {
        skipped++;
        continue;
      }

      const sourceContent = readFileSync(sourceFile, 'utf-8');
      const sourceHash = computeHash(sourceContent);

      // Check for local modifications
      if (existsSync(targetFile) && lock.installed[artifactPath]) {
        const localHash = computeHash(readFileSync(targetFile, 'utf-8'));
        if (
          localHash !== lock.installed[artifactPath].hash &&
          !options.force &&
          !options.resolveConflicts
        ) {
          // Special case: merge-strategy artifacts handle their own merging, not conflict
          if (
            artifact.merge_strategy !== 'settings-merge' &&
            artifact.merge_strategy !== 'gitignore-merge'
          ) {
            log(
              `  Conflict ${artifactPath}: local modifications detected`,
              'yellow',
            );
            log(`    Use --force or --resolve-conflicts to overwrite`, 'dim');
            conflicts++;
            continue;
          }
        } else if (
          localHash !== lock.installed[artifactPath].hash &&
          options.resolveConflicts
        ) {
          // --resolve-conflicts: accept upstream version for conflicting artifacts
          if (
            artifact.merge_strategy !== 'settings-merge' &&
            artifact.merge_strategy !== 'gitignore-merge'
          ) {
            log(
              `  Resolving conflict ${artifactPath}: accepting upstream`,
              'cyan',
            );
            resolved++;
          }
        }
      }

      // Create directory
      mkdirSync(dirname(targetFile), { recursive: true });

      // Handle special merge strategies
      if (artifact.merge_strategy === 'settings-merge') {
        const { merged, report } = mergeSettings(sourceContent, targetFile);
        writeFileSync(targetFile, merged);
        for (const msg of report) {
          log(msg, 'dim');
        }
      } else if (artifact.merge_strategy === 'gitignore-merge') {
        const { merged, report } = mergeGitignore(sourceContent, targetFile);
        writeFileSync(targetFile, merged);
        for (const msg of report) {
          log(msg, 'dim');
        }
      } else {
        // Standard copy
        copyFileSync(sourceFile, targetFile);
      }

      // Update lock
      // sg-sync-registry-gaps AC-2.1: lock entries include `path` field so
      // consumers and auditors can inspect the source artifact path without
      // cross-referencing the registry.
      lock.installed[artifactPath] = {
        version: artifact.version,
        hash: sourceHash,
        path: artifact.path,
        installed_at: new Date().toISOString(),
      };

      log(`  ✓ ${artifactPath}: ${artifact.version}@${sourceHash}`, 'green');
      synced++;
    }

    // Apply upstream deletions for obsolete lock entries. Safe delete only when
    // the consumer file still matches the recorded lock hash; modified files
    // are left in place unless --force is explicit.
    let pruned = 0;
    let deleted = 0;
    for (const [artifactPath, installed] of Object.entries(
      lock.installed || {},
    )) {
      if (targetArtifacts.has(artifactPath)) continue;

      const targetPath = resolveInstalledTargetPath(installed);
      if (!targetPath) {
        delete lock.installed[artifactPath];
        log(
          `  - ${artifactPath}: pruned obsolete lock entry (no target path recorded)`,
          'dim',
        );
        pruned++;
        continue;
      }

      if (
        isProtectedArtifact(
          projectConfig,
          artifactPath,
          targetPath,
          installed.path,
        )
      ) {
        log(`  Skip deletion ${artifactPath}: protected`, 'dim');
        skipped++;
        continue;
      }

      const targetFile = join(projectPath, targetPath);
      if (!existsSync(targetFile)) {
        delete lock.installed[artifactPath];
        log(
          `  - ${artifactPath}: pruned obsolete lock entry (file already absent)`,
          'dim',
        );
        pruned++;
        continue;
      }

      try {
        assertContainment(targetFile, join(projectPath, '.claude'));
      } catch (err) {
        const rule =
          err instanceof PathEscapeError ? 'path-escape' : 'path-check-failed';
        log(`  Conflict ${artifactPath}: deletion skipped (${rule})`, 'yellow');
        conflicts++;
        continue;
      }

      const localHash = computeHash(readFileSync(targetFile, 'utf-8'));
      const safeToDelete = installed.hash && localHash === installed.hash;
      if (!safeToDelete && !options.force) {
        log(
          `  Conflict ${artifactPath}: no longer targeted but locally modified`,
          'yellow',
        );
        log(
          '    Use --force to delete the local file and prune the lock',
          'dim',
        );
        conflicts++;
        continue;
      }

      rmSync(targetFile, { force: true });
      delete lock.installed[artifactPath];
      const reason = safeToDelete
        ? 'removed upstream/no longer in bundle'
        : 'forced deletion of locally modified obsolete artifact';
      log(`  - ${artifactPath}: deleted (${reason})`, 'yellow');
      deleted++;
    }

    // Update lock metadata
    lock.synced_at = new Date().toISOString();
    lock.registry_version = registry.registry_version;

    saveJson(lockPath, lock);

    const runtimeDepsResult = ensureConsumerRuntimeDependencies(
      projectPath,
      registry,
      targetArtifacts,
      options,
    );

    log('');
    const pendingMsg =
      pendingMerges.length > 0 ? `, ${pendingMerges.length} pending merge` : '';
    const prunedMsg = pruned > 0 ? `, ${pruned} pruned` : '';
    const deletedMsg = deleted > 0 ? `, ${deleted} deleted` : '';
    const resolvedMsg = resolved > 0 ? `, ${resolved} resolved` : '';
    log(
      `Complete: ${synced} synced, ${skipped} skipped, ${conflicts} conflicts${resolvedMsg}${pendingMsg}${deletedMsg}${prunedMsg}`,
    );
    logMcpEnsureResults(mcpEnsureResults);
    logRuntimeDependencyResult(runtimeDepsResult);

    // Report agent-assisted merges
    if (pendingMerges.length > 0) {
      log('');
      log(`Agent-Assisted Merges Pending (${pendingMerges.length}):`, 'yellow');
      for (const pm of pendingMerges) {
        log(`  ${pm.artifact} (v${pm.version}):`, 'yellow');
        log(`    Upstream staged: ${pm.upstream}`, 'dim');
        log(`    Local file:      ${pm.local}`, 'dim');
      }
      log('');
      log(
        'Merge upstream changes into local files, preserving project-specific content.',
        'dim',
      );
      log('Delete .claude/sync-pending/ after merging.', 'dim');
    }

    // Auto-repair session.json if it exists but is missing required fields
    const sessionJsonPath = join(
      projectPath,
      '.claude',
      'context',
      'session.json',
    );
    const sessionData = loadJson(sessionJsonPath);
    if (sessionData) {
      const defaults = {
        version: '1.0.0',
        updated_at: new Date().toISOString(),
        active_work: null,
        phase_checkpoint: null,
        subagent_tasks: { in_flight: [], completed_this_session: [] },
        history: [],
      };
      let repaired = false;
      for (const [key, defaultValue] of Object.entries(defaults)) {
        if (!(key in sessionData)) {
          sessionData[key] = defaultValue;
          repaired = true;
        }
      }
      if (repaired) {
        saveJson(sessionJsonPath, sessionData);
        log(`  Repaired session.json (added missing fields)`, 'green');
      }
    }
  }

  log('');
}

async function cmdVerify(projectArg, options) {
  const config = loadProjectsConfig();
  const registry = loadRegistry();
  const projects = getProjectsToProcess(config, projectArg);

  let totalPassed = 0;
  let totalFailed = 0;

  for (const projectName of projects) {
    const projectConfig = config.projects[projectName];
    const projectPath = resolveProjectPath(
      projectName,
      projectConfig,
      config.defaults,
      options,
    );
    const lockPath = getLockPath(projectName, projectPath);
    const lock = loadJson(lockPath);

    log(`\n${colors.bold}Verifying: ${projectName}${colors.reset}`, 'cyan');

    if (!lock) {
      log('No lock file found. Run: metaclaude sync ' + projectName, 'yellow');
      continue;
    }

    if (!existsSync(projectPath)) {
      log(`Project directory does not exist: ${projectPath}`, 'red');
      continue;
    }

    const bundleName = projectConfig.bundle || config.defaults?.bundle;
    if (!bundleName) {
      log('No bundle specified', 'yellow');
      continue;
    }
    const targetArtifacts = resolveTargetArtifactsForProject(
      registry,
      projectConfig,
      config.defaults,
    );

    let passed = 0;
    let failed = 0;

    for (const [artifactPath, installed] of Object.entries(lock.installed)) {
      if (!targetArtifacts.has(artifactPath)) {
        log(
          `✗ ${artifactPath}: no longer targeted (run metaclaude sync to delete/prune)`,
          'red',
        );
        failed++;
        continue;
      }

      // Get actual path from registry
      const artifact = getArtifact(registry, artifactPath);
      if (!artifact) {
        log(
          `✗ ${artifactPath}: not found in registry (run metaclaude sync to delete/prune)`,
          'red',
        );
        failed++;
        continue;
      }

      const targetPath = artifact.target_path || artifact.path;
      const localPath = join(projectPath, targetPath);

      if (!existsSync(localPath)) {
        log(`✗ ${artifactPath}: missing`, 'red');
        failed++;
        continue;
      }

      const effectivePolicy = getEffectiveSyncPolicy(
        registry,
        artifactPath,
        artifact,
      );
      const isAgentAssisted =
        projectConfig.sync_overrides?.[artifactPath] === 'agent-assisted' ||
        effectivePolicy === 'agent-assisted';
      const isNeverOverwrite = effectivePolicy === 'never-overwrite';

      // Local-owned policies intentionally preserve consumer edits. Their lock
      // hash records the upstream version seen by sync, not the local file
      // bytes, so strict local-vs-lock drift detection would be a false alarm.
      if (isAgentAssisted || isNeverOverwrite) {
        if (installed.hash !== artifact.hash) {
          log(
            `✗ ${artifactPath}: lock stale (expected upstream ${artifact.hash}, got ${installed.hash})`,
            'red',
          );
          failed++;
          continue;
        }

        if (isAgentAssisted) {
          const pendingPath = join(
            projectPath,
            '.claude',
            'sync-pending',
            targetPath,
          );
          if (existsSync(pendingPath)) {
            log(`✗ ${artifactPath}: agent-assisted merge pending`, 'red');
            failed++;
            continue;
          }
        }

        const label = isAgentAssisted ? 'agent-assisted' : 'never-overwrite';
        log(
          `✓ ${artifactPath}: ${installed.version}@${installed.hash} (${label}, local-owned)`,
          'green',
        );
        passed++;
        continue;
      }

      const localHash = computeHash(readFileSync(localPath, 'utf-8'));
      if (localHash !== installed.hash) {
        // Merge-strategy artifacts (settings-merge, gitignore-merge) produce merged files
        // whose hash will never match the source hash. Skip drift detection for these.
        if (
          artifact.merge_strategy === 'settings-merge' ||
          artifact.merge_strategy === 'gitignore-merge'
        ) {
          log(
            `✓ ${artifactPath}: ${installed.version}@${installed.hash} (merge-managed)`,
            'green',
          );
          passed++;
        } else {
          log(
            `✗ ${artifactPath}: drift detected (expected ${installed.hash}, got ${localHash})`,
            'red',
          );
          failed++;
        }
      } else {
        log(
          `✓ ${artifactPath}: ${installed.version}@${installed.hash}`,
          'green',
        );
        passed++;
      }
    }

    totalPassed += passed;
    totalFailed += failed;

    log('');
    if (failed > 0) {
      log(`Failed: ${passed} passed, ${failed} failed`, 'red');
    } else {
      log(`Passed: ${passed} artifacts verified`, 'green');
    }
  }

  log('');
  if (totalFailed > 0) {
    process.exit(1);
  }
}

async function cmdAdd(projectName, options) {
  if (!projectName) {
    log(
      'Usage: metaclaude add <project-name> [--path=<path>] [--bundle=<bundle>]',
      'yellow',
    );
    process.exit(1);
  }

  const configPath = join(METACLAUDE_ROOT, '.claude', 'projects.json');
  const config = loadProjectsConfig();

  if (config.projects[projectName]) {
    log(`Project already exists: ${projectName}`, 'yellow');
    process.exit(1);
  }

  // Build project config
  const projectConfig = {};

  if (options.path) {
    projectConfig.path = options.path;
  }

  if (options.bundle) {
    projectConfig.bundle = options.bundle;
  }

  // Resolve and verify path
  const resolvedPath = resolveProjectPath(
    projectName,
    projectConfig,
    config.defaults,
    options,
  );

  if (!existsSync(resolvedPath)) {
    log(`Warning: Directory does not exist: ${resolvedPath}`, 'yellow');
    log(
      'The project will be added but sync will fail until the directory exists.',
      'dim',
    );
  }

  config.projects[projectName] = projectConfig;
  saveJson(configPath, config);

  log(`Added project: ${projectName}`, 'green');
  log(`  Path: ${resolvedPath}`, 'dim');
  log(
    `  Bundle: ${projectConfig.bundle || config.defaults?.bundle || '(default)'}`,
    'dim',
  );
  log('');
  log(`Next: metaclaude sync ${projectName}`, 'cyan');
}

async function cmdRemove(projectName) {
  if (!projectName) {
    log('Usage: metaclaude remove <project-name>', 'yellow');
    process.exit(1);
  }

  const configPath = join(METACLAUDE_ROOT, '.claude', 'projects.json');
  const config = loadProjectsConfig();

  if (!config.projects[projectName]) {
    log(`Project not found: ${projectName}`, 'red');
    process.exit(1);
  }

  delete config.projects[projectName];
  saveJson(configPath, config);

  // Optionally remove lock file
  const lockPath = getLockPath(projectName);
  if (existsSync(lockPath)) {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(lockPath);
    log(`Removed lock file: ${lockPath}`, 'dim');
  }

  log(`Removed project: ${projectName}`, 'green');
}

// ============== CLEAN (ORPHAN REMOVAL) ==============

async function cmdClean(projectArg, options) {
  const config = loadProjectsConfig();
  const registry = loadRegistry();
  const orphans = registry.orphans || [];

  if (orphans.length === 0) {
    log('No orphans defined in registry.', 'dim');
    return;
  }

  const projects = getProjectsToProcess(config, projectArg);

  for (const projectName of projects) {
    const projectConfig = config.projects[projectName];
    const projectPath = resolveProjectPath(
      projectName,
      projectConfig,
      config.defaults,
      options,
    );

    if (!existsSync(projectPath)) {
      log(
        `\nSkipping ${projectName}: directory not found at ${projectPath}`,
        'yellow',
      );
      continue;
    }

    log(`\n${projectName}`, 'cyan');
    log(`Target: ${projectPath}`, 'dim');

    let removed = 0;
    for (const orphanPath of orphans) {
      const fullPath = join(projectPath, orphanPath);
      if (existsSync(fullPath)) {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(fullPath);
        log(`  ✗ Removed: ${orphanPath}`, 'yellow');
        removed++;

        // Clean up empty parent directories
        try {
          const { rmdirSync, readdirSync } = await import('node:fs');
          const parentDir = dirname(fullPath);
          if (readdirSync(parentDir).length === 0) {
            rmdirSync(parentDir);
            log(`  ✗ Removed empty dir: ${dirname(orphanPath)}`, 'dim');
          }
        } catch {
          /* dir not empty, that's fine */
        }
      }
    }

    if (removed === 0) {
      log('  No orphans found.', 'dim');
    } else {
      log(`  Removed ${removed} orphan(s).`, 'green');
    }
  }
}

// ============== MAIN ==============

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Parse options
  const options = {
    force: args.includes('--force'),
    resolveConflicts: args.includes('--resolve-conflicts'),
    ackDrift: args.includes('--ack-drift'),
    runtimeDeps: !args.includes('--no-runtime-deps'),
    mcpEnsure: !args.includes('--no-mcp-ensure'),
    baseDir: args.find((a) => a.startsWith('--base-dir='))?.split('=')[1],
    path: args.find((a) => a.startsWith('--path='))?.split('=')[1],
    bundle: args.find((a) => a.startsWith('--bundle='))?.split('=')[1],
  };

  // Get positional arg (project name for most commands)
  const positionalArgs = args.filter(
    (a) => !a.startsWith('--') && a !== command,
  );
  const projectArg = positionalArgs[0];

  switch (command) {
    case 'list':
    case 'ls':
      await cmdList();
      break;
    case 'status':
    case 'st':
      await cmdStatus(projectArg, options);
      break;
    case 'sync':
      await cmdSync(projectArg, options);
      break;
    case 'verify':
      await cmdVerify(projectArg, options);
      break;
    case 'add':
      await cmdAdd(projectArg, options);
      break;
    case 'remove':
    case 'rm':
      await cmdRemove(projectArg);
      break;
    case 'clean':
      await cmdClean(projectArg, options);
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      console.error(`
MetaClaude CLI - Centralized artifact sync across repositories

Commands:
  list                      List configured projects
  status [project]          Check for available updates
  sync [project]            Push artifacts to target repos
  verify [project]          Verify installed artifacts match lock
  add <name> [options]      Add a project to configuration
  remove <name>             Remove a project from configuration
  clean [project]           Remove orphaned artifacts from target repos

Options:
  --base-dir=<path>         Override default base directory for path resolution
  --force                   Force overwrite on conflicts
  --resolve-conflicts       Accept upstream version for conflicting artifacts only
  --ack-drift               (sync) Acknowledge shadow-file divergence: advance lock hash without touching the consumer file
  --no-runtime-deps         (sync) Skip provisioning .claude/node_modules for synced hooks/scripts
  --no-mcp-ensure           (sync) Skip Claude Code MCP add/get ensure checks
  --path=<path>             (add) Explicit path for project
  --bundle=<bundle>         (add) Bundle to use

Examples:
  metaclaude list
  metaclaude status
  metaclaude status my-project
  metaclaude sync
  metaclaude sync my-project --force
  metaclaude sync my-project --resolve-conflicts
  metaclaude add my-project
  metaclaude add my-project --path=/custom/path --bundle=core-workflow
  metaclaude remove my-project
`);
      break;
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
