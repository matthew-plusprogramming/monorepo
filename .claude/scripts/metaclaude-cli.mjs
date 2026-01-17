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
 *
 * Global Options:
 *   --base-dir=<path>       - Override default base directory
 *   --force                 - Force overwrite on conflicts
 *
 * Usage:
 *   node metaclaude-cli.mjs <command> [project] [options]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, basename, join, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
  console.log(`${colors[color]}${msg}${colors.reset}`);
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

    for (const artifactPath of [...targetArtifacts].sort()) {
      const artifact = getArtifact(registry, artifactPath);
      if (!artifact) {
        log(`? ${artifactPath} - not found in registry`, 'yellow');
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
            log(`* ${artifactPath}: ${artifact.version}@${artifact.hash} (locally modified)`, 'yellow');
            modified++;
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
    log(`Summary: ${current} current, ${updatesAvailable} updates, ${missing} missing, ${modified} modified`);
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

      const sourceContent = readFileSync(sourceFile, 'utf-8');
      const sourceHash = computeHash(sourceContent);

      // Check for local modifications
      if (existsSync(targetFile) && lock.installed[artifactPath]) {
        const localHash = computeHash(readFileSync(targetFile, 'utf-8'));
        if (localHash !== lock.installed[artifactPath].hash && !options.force) {
          log(`  Conflict ${artifactPath}: local modifications detected`, 'yellow');
          log(`    Use --force to overwrite or add to protected list`, 'dim');
          conflicts++;
          continue;
        }
      }

      // Create directory and copy file
      mkdirSync(dirname(targetFile), { recursive: true });
      copyFileSync(sourceFile, targetFile);

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
    const prunedMsg = pruned > 0 ? `, ${pruned} pruned` : '';
    log(`Complete: ${synced} synced, ${skipped} skipped, ${conflicts} conflicts${prunedMsg}`);
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
        log(`✗ ${artifactPath}: drift detected (expected ${installed.hash}, got ${localHash})`, 'red');
        failed++;
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

// ============== MAIN ==============

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Parse options
  const options = {
    force: args.includes('--force'),
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
    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(`
MetaClaude CLI - Centralized artifact sync across repositories

Commands:
  list                      List configured projects
  status [project]          Check for available updates
  sync [project]            Push artifacts to target repos
  verify [project]          Verify installed artifacts match lock
  add <name> [options]      Add a project to configuration
  remove <name>             Remove a project from configuration

Options:
  --base-dir=<path>         Override default base directory for path resolution
  --force                   Force overwrite on conflicts
  --path=<path>             (add) Explicit path for project
  --bundle=<bundle>         (add) Bundle to use

Examples:
  metaclaude list
  metaclaude status
  metaclaude status my-project
  metaclaude sync
  metaclaude sync my-project --force
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
