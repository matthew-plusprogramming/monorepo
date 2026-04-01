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
 *
 * Sync Overrides (per-project in projects.json):
 *   "agent-assisted"        - Stage upstream to .claude/sync-pending/ for manual merge
 *
 * Usage:
 *   node metaclaude-cli.mjs <command> [project] [options]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, basename, join, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mergeGitignore } from './lib/gitignore-merge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METACLAUDE_ROOT = resolve(__dirname, '../..');

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
  const registryPath = join(METACLAUDE_ROOT, '.claude', 'metaclaude-registry.json');
  const registry = loadJson(registryPath);
  if (!registry) {
    log('Registry not found at .claude/metaclaude-registry.json', 'red');
    process.exit(1);
  }
  return registry;
}

function resolveProjectPath(projectName, projectConfig, defaults, options = {}) {
  // Explicit path in config takes priority
  if (projectConfig.path) {
    return isAbsolute(projectConfig.path)
      ? projectConfig.path
      : resolve(METACLAUDE_ROOT, projectConfig.path);
  }

  // Use base_dir from options, defaults, or fallback to '..'
  const baseDir = options.baseDir || defaults?.base_dir || '..';
  const resolvedBase = isAbsolute(baseDir) ? baseDir : resolve(METACLAUDE_ROOT, baseDir);
  return join(resolvedBase, projectName);
}

function getLockPath(projectName) {
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
  const [category, name] = artifactPath.split('/');
  return registry.artifacts[category]?.[name];
}

function getProjectsToProcess(config, projectArg) {
  if (projectArg) {
    if (!config.projects[projectArg]) {
      log(`Project not found: ${projectArg}`, 'red');
      log(`Available projects: ${Object.keys(config.projects).join(', ') || '(none)'}`, 'dim');
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
      let targetGroup = targetHookGroups.find(g => (g.matcher || '*') === matcher);

      if (!targetGroup) {
        // No matching group in target, use source group directly (excluding _sync: false hooks)
        const syncableHooks = (sourceGroup.hooks || []).filter(h => h._sync !== false);
        mergedHookGroups.push({ ...sourceGroup, hooks: syncableHooks });
        report.push(`  Added hook group [${hookType}] matcher="${matcher}"`);
      } else {
        // Merge hooks within the group
        const targetHooks = targetGroup.hooks || [];
        const sourceHooks = sourceGroup.hooks || [];

        // Remove metaclaude hooks from target
        const projectHooks = targetHooks.filter(h => h._source !== 'metaclaude');
        const removedCount = targetHooks.length - projectHooks.length;
        if (removedCount > 0) {
          report.push(`  Removed ${removedCount} existing metaclaude hooks from [${hookType}] matcher="${matcher}"`);
        }

        // Add all source hooks (all have _source: "metaclaude"), excluding _sync: false hooks
        const metaclaudeHooks = sourceHooks.filter(h => h._source === 'metaclaude' && h._sync !== false);

        if (projectHooks.length > 0) {
          report.push(`  Preserved ${projectHooks.length} project-specific hooks in [${hookType}] matcher="${matcher}"`);
        }
        report.push(`  Added ${metaclaudeHooks.length} metaclaude hooks to [${hookType}] matcher="${matcher}"`);

        mergedHookGroups.push({
          ...sourceGroup,
          hooks: [...metaclaudeHooks, ...projectHooks]
        });
      }
    }

    // Also preserve any target hook groups that don't exist in source
    for (const targetGroup of targetHookGroups) {
      const matcher = targetGroup.matcher || '*';
      const existsInSource = sourceHookGroups.some(g => (g.matcher || '*') === matcher);

      if (!existsInSource) {
        // This is a project-specific hook group, preserve it
        // But still filter out any metaclaude hooks that may have been added previously
        const projectHooks = (targetGroup.hooks || []).filter(h => h._source !== 'metaclaude');
        if (projectHooks.length > 0) {
          mergedHookGroups.push({
            ...targetGroup,
            hooks: projectHooks
          });
          report.push(`  Preserved project hook group [${hookType}] matcher="${matcher}" (${projectHooks.length} hooks)`);
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
    const projectPath = resolveProjectPath(projectName, projectConfig, config.defaults, options);
    const lockPath = getLockPath(projectName);
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

    const targetArtifacts = resolveBundleArtifacts(registry, bundleName);

    // Add additional artifacts
    if (projectConfig.additional) {
      projectConfig.additional.forEach(a => targetArtifacts.add(a));
    }

    // Remove excluded
    if (projectConfig.excluded) {
      projectConfig.excluded.forEach(a => targetArtifacts.delete(a));
    }

    let updatesAvailable = 0;
    let missing = 0;
    let current = 0;
    let modified = 0;
    let agentAssisted = 0;

    for (const artifactPath of [...targetArtifacts].sort()) {
      const artifact = getArtifact(registry, artifactPath);
      if (!artifact) {
        log(`? ${artifactPath} - not found in registry`, 'yellow');
        continue;
      }

      // Show agent-assisted artifacts with distinct indicator
      const [statusCategory] = artifactPath.split('/');
      const statusCategoryMeta = registry.artifacts[statusCategory];
      const statusEffectivePolicy = artifact._sync_policy || statusCategoryMeta?._sync_policy;
      const statusIsAgentAssisted = projectConfig.sync_overrides?.[artifactPath] === 'agent-assisted'
        || statusEffectivePolicy === 'agent-assisted';
      if (statusIsAgentAssisted) {
        const installed = lock.installed[artifactPath];
        const hasUpdate = installed ? installed.hash !== artifact.hash : true;
        if (hasUpdate) {
          log(`⊕ ${artifactPath}: ${artifact.version}@${artifact.hash} (agent-assisted merge needed)`, 'cyan');
          agentAssisted++;
        } else {
          log(`⊕ ${artifactPath}: ${artifact.version}@${artifact.hash} (agent-assisted, up to date)`, 'dim');
          current++;
        }
        continue;
      }

      const installed = lock.installed[artifactPath];
      const targetPath = artifact.target_path || artifact.path;
      const localPath = join(projectPath, targetPath);
      const localExists = existsSync(localPath);

      if (!installed && !localExists) {
        log(`+ ${artifactPath}: ${artifact.version}@${artifact.hash} (not installed)`, 'yellow');
        missing++;
      } else if (!installed && localExists) {
        const localHash = computeHash(readFileSync(localPath, 'utf-8'));
        if (localHash === artifact.hash) {
          log(`= ${artifactPath}: ${artifact.version}@${artifact.hash} (unlocked but matches)`, 'dim');
          current++;
        } else {
          log(`~ ${artifactPath}: local differs from upstream`, 'yellow');
          modified++;
        }
      } else if (installed.hash !== artifact.hash) {
        log(`↑ ${artifactPath}: ${installed.version}@${installed.hash} → ${artifact.version}@${artifact.hash}`, 'green');
        updatesAvailable++;
      } else {
        // Check for local modifications
        if (localExists) {
          const localHash = computeHash(readFileSync(localPath, 'utf-8'));
          if (localHash !== installed.hash) {
            if (artifact.merge_strategy === 'settings-merge' || artifact.merge_strategy === 'gitignore-merge') {
              log(`  ${artifactPath}: ${artifact.version}@${artifact.hash} (merged)`, 'dim');
              // Don't increment modified count - merge-strategy artifacts are expected to differ
            } else {
              log(`* ${artifactPath}: ${artifact.version}@${artifact.hash} (locally modified)`, 'yellow');
              modified++;
            }
          } else {
            log(`✓ ${artifactPath}: ${artifact.version}@${artifact.hash}`, 'dim');
            current++;
          }
        } else {
          log(`! ${artifactPath}: locked but missing locally`, 'red');
          missing++;
        }
      }
    }

    log('');
    const agentMsg = agentAssisted > 0 ? `, ${agentAssisted} agent-assisted` : '';
    log(`Summary: ${current} current, ${updatesAvailable} updates, ${missing} missing, ${modified} modified${agentMsg}`);
  }

  log('');
}

async function cmdSync(projectArg, options) {
  const config = loadProjectsConfig();
  const registry = loadRegistry();
  const projects = getProjectsToProcess(config, projectArg);

  for (const projectName of projects) {
    const projectConfig = config.projects[projectName];
    const projectPath = resolveProjectPath(projectName, projectConfig, config.defaults, options);
    const lockPath = getLockPath(projectName);

    log(`\n${colors.bold}Syncing: ${projectName}${colors.reset}`, 'cyan');
    log(`Target: ${projectPath}`, 'dim');

    if (!existsSync(projectPath)) {
      log(`Project directory does not exist: ${projectPath}`, 'red');
      log('Create the directory or update the path in projects.json', 'dim');
      continue;
    }

    const lock = loadJson(lockPath) || {
      lock_version: '1.0.0',
      project: projectName,
      synced_at: null,
      registry_version: registry.registry_version,
      installed: {}
    };

    // Resolve target artifacts
    const bundleName = projectConfig.bundle || config.defaults?.bundle;
    if (!bundleName) {
      log('No bundle specified, skipping', 'yellow');
      continue;
    }

    const targetArtifacts = resolveBundleArtifacts(registry, bundleName);
    if (projectConfig.additional) {
      projectConfig.additional.forEach(a => targetArtifacts.add(a));
    }
    if (projectConfig.excluded) {
      projectConfig.excluded.forEach(a => targetArtifacts.delete(a));
    }

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
      if (projectConfig.protected?.includes(artifact.path)) {
        log(`  Skip ${artifactPath}: protected`, 'dim');
        skipped++;
        continue;
      }

      // Check sync policies (category-level and per-artifact)
      const [category] = artifactPath.split('/');
      const categoryMeta = registry.artifacts[category];
      const effectivePolicy = artifact._sync_policy || categoryMeta?._sync_policy;

      // DEC-002: never-sync means never propagate to consumer projects at all
      if (effectivePolicy === 'never-sync') {
        log(`  Skip ${artifactPath}: never-sync policy (excluded from sync)`, 'dim');
        skipped++;
        continue;
      }

      // never-overwrite means propagate once, then do not overwrite if target exists
      if (effectivePolicy === 'never-overwrite' && existsSync(targetFile)) {
        log(`  Skip ${artifactPath}: never-overwrite policy (file exists)`, 'dim');
        skipped++;
        continue;
      }

      // Check for agent-assisted policy (per-project override OR registry-level)
      const isAgentAssisted = projectConfig.sync_overrides?.[artifactPath] === 'agent-assisted'
        || (effectivePolicy === 'agent-assisted' && existsSync(targetFile));
      if (isAgentAssisted) {
        const srcContent = readFileSync(sourceFile, 'utf-8');
        const srcHash = computeHash(srcContent);
        const installed = lock.installed[artifactPath];

        // Skip if upstream hasn't changed since last sync
        if (installed && installed.hash === srcHash) {
          log(`  Skip ${artifactPath}: agent-assisted (no upstream changes)`, 'dim');
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
          installed_at: new Date().toISOString()
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

      const sourceContent = readFileSync(sourceFile, 'utf-8');
      const sourceHash = computeHash(sourceContent);

      // Check for local modifications
      if (existsSync(targetFile) && lock.installed[artifactPath]) {
        const localHash = computeHash(readFileSync(targetFile, 'utf-8'));
        if (localHash !== lock.installed[artifactPath].hash && !options.force && !options.resolveConflicts) {
          // Special case: merge-strategy artifacts handle their own merging, not conflict
          if (artifact.merge_strategy !== 'settings-merge' && artifact.merge_strategy !== 'gitignore-merge') {
            log(`  Conflict ${artifactPath}: local modifications detected`, 'yellow');
            log(`    Use --force or --resolve-conflicts to overwrite`, 'dim');
            conflicts++;
            continue;
          }
        } else if (localHash !== lock.installed[artifactPath].hash && options.resolveConflicts) {
          // --resolve-conflicts: accept upstream version for conflicting artifacts
          if (artifact.merge_strategy !== 'settings-merge' && artifact.merge_strategy !== 'gitignore-merge') {
            log(`  Resolving conflict ${artifactPath}: accepting upstream`, 'cyan');
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
      lock.installed[artifactPath] = {
        version: artifact.version,
        hash: sourceHash,
        installed_at: new Date().toISOString()
      };

      log(`  ✓ ${artifactPath}: ${artifact.version}@${sourceHash}`, 'green');
      synced++;
    }

    // Prune obsolete lock entries (artifacts no longer in target set)
    let pruned = 0;
    for (const artifactPath of Object.keys(lock.installed)) {
      if (!targetArtifacts.has(artifactPath)) {
        delete lock.installed[artifactPath];
        log(`  - ${artifactPath}: removed (no longer in bundle)`, 'dim');
        pruned++;
      }
    }

    // Update lock metadata
    lock.synced_at = new Date().toISOString();
    lock.registry_version = registry.registry_version;

    saveJson(lockPath, lock);

    log('');
    const pendingMsg = pendingMerges.length > 0 ? `, ${pendingMerges.length} pending merge` : '';
    const prunedMsg = pruned > 0 ? `, ${pruned} pruned` : '';
    const resolvedMsg = resolved > 0 ? `, ${resolved} resolved` : '';
    log(`Complete: ${synced} synced, ${skipped} skipped, ${conflicts} conflicts${resolvedMsg}${pendingMsg}${prunedMsg}`);

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
      log('Merge upstream changes into local files, preserving project-specific content.', 'dim');
      log('Delete .claude/sync-pending/ after merging.', 'dim');
    }

    // Auto-repair session.json if it exists but is missing required fields
    const sessionJsonPath = join(projectPath, '.claude', 'context', 'session.json');
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
    const projectPath = resolveProjectPath(projectName, projectConfig, config.defaults, options);
    const lockPath = getLockPath(projectName);
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

    let passed = 0;
    let failed = 0;

    for (const [artifactPath, installed] of Object.entries(lock.installed)) {
      // Get actual path from registry
      const artifact = getArtifact(registry, artifactPath);
      if (!artifact) {
        log(`? ${artifactPath}: not found in registry`, 'yellow');
        continue;
      }

      const targetPath = artifact.target_path || artifact.path;
      const localPath = join(projectPath, targetPath);

      if (!existsSync(localPath)) {
        log(`✗ ${artifactPath}: missing`, 'red');
        failed++;
        continue;
      }

      const localHash = computeHash(readFileSync(localPath, 'utf-8'));
      if (localHash !== installed.hash) {
        // Merge-strategy artifacts (settings-merge, gitignore-merge) produce merged files
        // whose hash will never match the source hash. Skip drift detection for these.
        if (artifact.merge_strategy === 'settings-merge' || artifact.merge_strategy === 'gitignore-merge') {
          log(`✓ ${artifactPath}: ${installed.version}@${installed.hash} (merge-managed)`, 'green');
          passed++;
        } else {
          log(`✗ ${artifactPath}: drift detected (expected ${installed.hash}, got ${localHash})`, 'red');
          failed++;
        }
      } else {
        log(`✓ ${artifactPath}: ${installed.version}@${installed.hash}`, 'green');
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
    log('Usage: metaclaude add <project-name> [--path=<path>] [--bundle=<bundle>]', 'yellow');
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
  const resolvedPath = resolveProjectPath(projectName, projectConfig, config.defaults, options);

  if (!existsSync(resolvedPath)) {
    log(`Warning: Directory does not exist: ${resolvedPath}`, 'yellow');
    log('The project will be added but sync will fail until the directory exists.', 'dim');
  }

  config.projects[projectName] = projectConfig;
  saveJson(configPath, config);

  log(`Added project: ${projectName}`, 'green');
  log(`  Path: ${resolvedPath}`, 'dim');
  log(`  Bundle: ${projectConfig.bundle || config.defaults?.bundle || '(default)'}`, 'dim');
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
    const projectPath = resolveProjectPath(projectName, projectConfig, config.defaults, options);

    if (!existsSync(projectPath)) {
      log(`\nSkipping ${projectName}: directory not found at ${projectPath}`, 'yellow');
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
        } catch { /* dir not empty, that's fine */ }
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
    baseDir: args.find(a => a.startsWith('--base-dir='))?.split('=')[1],
    path: args.find(a => a.startsWith('--path='))?.split('=')[1],
    bundle: args.find(a => a.startsWith('--bundle='))?.split('=')[1],
  };

  // Get positional arg (project name for most commands)
  const positionalArgs = args.filter(a => !a.startsWith('--') && a !== command);
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

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
