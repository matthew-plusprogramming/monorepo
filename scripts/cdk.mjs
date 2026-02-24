#!/usr/bin/env node

/**
 * CDK Unified Orchestrator
 *
 * A flattened deployment script that directly invokes cdktf with proper
 * environment handling. Replaces the deep npm script chain:
 *   orchestrator → npm → cross-env → cross-env-shell → dotenvx → cdktf
 *
 * Now just:
 *   cdk.mjs → cdktf (with env loaded programmatically)
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { checkArtifactFreshness, formatTimeDelta, formatTimestamp, ARTIFACT_SOURCE_DIRS } from './utils/cdk-freshness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CDK_ROOT = join(REPO_ROOT, 'cdk', 'platform-cdk');
const OUTPUTS_DIR = join(CDK_ROOT, 'cdktf-outputs', 'stacks');
const DIST_DIR = join(CDK_ROOT, 'dist');

const LOG_PREFIX = '[cdk]';

// ============================================================================
// Stack Definitions
// ============================================================================

const STACK_DEFINITIONS = {
  'myapp-bootstrap-stack': {
    description: 'Bootstrap stack for CDKTF backend state',
    dependencies: [],
    requiredOutputs: [],
    requiredArtifacts: [],
    providesOutputs: false,
  },
  'myapp-api-stack': {
    description: 'DynamoDB tables for the API',
    dependencies: ['myapp-bootstrap-stack'],
    requiredOutputs: [],
    requiredArtifacts: [],
    providesOutputs: true,
  },
  'myapp-api-lambda-stack': {
    description: 'API Lambda function',
    dependencies: ['myapp-api-stack'],
    requiredOutputs: ['myapp-api-stack'],
    requiredArtifacts: ['lambdas/api/lambda.zip'],
    providesOutputs: true,
  },
  'myapp-analytics-stack': {
    description: 'EventBridge and analytics infrastructure',
    dependencies: ['myapp-bootstrap-stack'],
    requiredOutputs: [],
    requiredArtifacts: [],
    providesOutputs: true,
  },
  'myapp-analytics-lambda-stack': {
    description: 'Analytics processor Lambda',
    dependencies: ['myapp-analytics-stack'],
    requiredOutputs: ['myapp-analytics-stack'],
    requiredArtifacts: ['lambdas/analytics/analytics-processor-lambda.zip'],
    providesOutputs: true,
  },
  'myapp-client-website-stack': {
    description: 'S3 + CloudFront for static website',
    dependencies: ['myapp-bootstrap-stack'],
    requiredOutputs: [],
    requiredArtifacts: [],
    providesOutputs: true,
  },
};

const DEPLOYMENT_GROUPS = {
  infra: ['myapp-api-stack', 'myapp-analytics-stack'],
  lambdas: ['myapp-api-lambda-stack', 'myapp-analytics-lambda-stack'],
  website: ['myapp-client-website-stack'],
  all: [
    'myapp-bootstrap-stack',
    'myapp-api-stack',
    'myapp-api-lambda-stack',
    'myapp-analytics-stack',
    'myapp-analytics-lambda-stack',
    'myapp-client-website-stack',
  ],
};

// ============================================================================
// Environment Loading
// ============================================================================

/**
 * Load environment variables from .env files using dotenvx
 * Handles encrypted files and provides helpful error messages
 *
 * Loads two env files:
 * 1. cdk/platform-cdk/.env.{stage} - AWS/infra config (loaded first, takes precedence)
 * 2. apps/node-server/.env.{stage} - App secrets (JWT_SECRET, PEPPER, etc.)
 */
const loadEnv = async (stage) => {
  const cdkEnvFile = join(CDK_ROOT, `.env.${stage}`);
  const nodeServerEnvFile = join(REPO_ROOT, 'apps', 'node-server', `.env.${stage}`);

  // Validate both env files exist
  if (!existsSync(cdkEnvFile)) {
    throw new Error(`CDK environment file not found: ${cdkEnvFile}`);
  }

  if (!existsSync(nodeServerEnvFile)) {
    throw new Error(
      `Node server environment file not found: ${nodeServerEnvFile}\n` +
      `Lambda deployment requires app secrets (JWT_SECRET, PEPPER) from this file.\n` +
      `Create ${nodeServerEnvFile} with the required secrets.`
    );
  }

  // Dynamically import dotenvx
  const { config } = await import('@dotenvx/dotenvx');

  // Load CDK env file first (these take precedence)
  const cdkResult = config({ path: cdkEnvFile });

  if (cdkResult.error) {
    const errorMsg = cdkResult.error.message || String(cdkResult.error);
    handleDotenvxError(errorMsg, CDK_ROOT);
    throw new Error(`Failed to load CDK environment: ${errorMsg}`);
  }

  // Load node-server env file second (override: false means CDK values take precedence)
  const nodeServerResult = config({ path: nodeServerEnvFile, override: false });

  if (nodeServerResult.error) {
    const errorMsg = nodeServerResult.error.message || String(nodeServerResult.error);
    handleDotenvxError(errorMsg, join(REPO_ROOT, 'apps', 'node-server'));
    throw new Error(`Failed to load node-server environment: ${errorMsg}`);
  }

  // Validate required variables
  if (!process.env.AWS_REGION) {
    throw new Error('AWS_REGION is not set. Check your CDK .env file.');
  }

  // Validate Lambda secrets
  validateLambdaSecrets();

  return { ...cdkResult.parsed, ...nodeServerResult.parsed };
};

/**
 * Handle dotenvx errors with helpful messages
 */
const handleDotenvxError = (errorMsg, envDir) => {
  if (/MISSING_PRIVATE_KEY|DOTENV_PRIVATE_KEY/i.test(errorMsg)) {
    const envKeysPath = join(envDir, '.env.keys');
    const hasEnvKeys = existsSync(envKeysPath);
    const inWorktree = process.cwd().includes('.worktrees');

    console.error(`\n${LOG_PREFIX} dotenvx reported missing private key(s).`);

    if (!hasEnvKeys && inWorktree) {
      console.error(`${LOG_PREFIX} This looks like a worktree missing .env.keys.`);
      console.error(`${LOG_PREFIX} Run: node .claude/scripts/sync-worktree-env-keys.mjs`);
    } else if (!hasEnvKeys) {
      console.error(`${LOG_PREFIX} No .env.keys file found at ${envKeysPath}.`);
      console.error(`${LOG_PREFIX} Add .env.keys or re-encrypt envs with your own key.`);
    } else {
      console.error(`${LOG_PREFIX} Verify the DOTENV_PRIVATE_KEY values in .env.keys match the encrypted env files.`);
    }
  }
};

/**
 * Validate that required Lambda secrets are present in process.env
 * Called after loading both env files
 */
const validateLambdaSecrets = () => {
  const requiredSecrets = ['JWT_SECRET', 'PEPPER'];
  const missing = requiredSecrets.filter((secret) => !process.env[secret]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required Lambda secrets: ${missing.join(', ')}\n` +
      `These secrets should be defined in apps/node-server/.env.{stage}.\n` +
      `Add the missing secrets and encrypt with: npx dotenvx encrypt -f apps/node-server/.env.{stage}`
    );
  }
};

// ============================================================================
// Command Execution
// ============================================================================

/**
 * Run a command and return a promise
 */
const runCommand = (command, args = [], options = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const { cwd = REPO_ROOT, env = process.env, step, silent = false } = options;
    const display = [command, ...args].join(' ');

    if (step && !silent) {
      console.log(`\n${LOG_PREFIX} ${step}`);
    }
    if (!silent) {
      console.log(`${LOG_PREFIX} $ ${display}`);
    }

    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env,
      shell: false,
    });

    child.on('error', (error) => {
      rejectPromise(error);
    });

    child.on('close', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`Command terminated with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error(`Command exited with code ${code}`));
        return;
      }
      resolvePromise();
    });
  });

/**
 * Run cdktf command with proper environment
 */
const runCdktf = async (args, options = {}) => {
  const { stage = 'dev', step } = options;

  // Load environment for the stage
  await loadEnv(stage);

  return runCommand('cdktf', args, {
    cwd: CDK_ROOT,
    env: process.env,
    step,
  });
};

// ============================================================================
// State Detection
// ============================================================================

const checkOutputExists = (stackName) => {
  const outputPath = join(OUTPUTS_DIR, stackName, 'outputs.json');
  return existsSync(outputPath);
};

const checkArtifactExists = (artifactPath) => {
  const fullPath = join(DIST_DIR, artifactPath);
  return existsSync(fullPath);
};

const checkAppDistExists = (appName) => {
  const distPath = join(REPO_ROOT, 'apps', appName, 'dist');
  return existsSync(distPath) && readdirSync(distPath).length > 0;
};

const getSystemState = () => {
  const outputs = {};
  const artifacts = {};
  const appBuilds = {};

  for (const [name, def] of Object.entries(STACK_DEFINITIONS)) {
    if (def.providesOutputs) {
      outputs[name] = checkOutputExists(name);
    }
    for (const artifact of def.requiredArtifacts) {
      artifacts[artifact] = checkArtifactExists(artifact);
    }
  }

  appBuilds['node-server'] = checkAppDistExists('node-server');
  appBuilds['analytics-lambda'] = checkAppDistExists('analytics-lambda');
  appBuilds['client-website'] = existsSync(join(REPO_ROOT, 'apps', 'client-website', 'out'));

  return { outputs, artifacts, appBuilds };
};

// ============================================================================
// Commands
// ============================================================================

const cmdStatus = () => {
  const state = getSystemState();

  console.log(`\n${LOG_PREFIX} === System Status ===\n`);

  console.log('CDK Outputs:');
  for (const [name, exists] of Object.entries(state.outputs)) {
    const icon = exists ? '✅' : '❌';
    console.log(`  ${icon} ${name}`);
  }

  console.log('\nLambda Artifacts:');
  for (const [path, exists] of Object.entries(state.artifacts)) {
    const icon = exists ? '✅' : '❌';
    console.log(`  ${icon} ${path}`);
  }

  console.log('\nApp Builds:');
  for (const [name, exists] of Object.entries(state.appBuilds)) {
    const icon = exists ? '✅' : '❌';
    console.log(`  ${icon} ${name}`);
  }

  console.log('');
};

const cmdValidate = (stacks) => {
  console.log(`\n${LOG_PREFIX} === Validation ===\n`);

  let allValid = true;
  const state = getSystemState();

  for (const stackName of stacks) {
    const def = STACK_DEFINITIONS[stackName];
    if (!def) {
      console.log(`❌ ${stackName}: Unknown stack`);
      allValid = false;
      continue;
    }

    const errors = [];

    for (const requiredOutput of def.requiredOutputs) {
      if (!state.outputs[requiredOutput]) {
        errors.push(`Missing output from ${requiredOutput}`);
      }
    }

    for (const artifact of def.requiredArtifacts) {
      if (!state.artifacts[artifact]) {
        errors.push(`Missing artifact: ${artifact}`);
      }
    }

    if (errors.length === 0) {
      console.log(`✅ ${stackName}: Ready to deploy`);
    } else {
      allValid = false;
      console.log(`❌ ${stackName}: Not ready`);
      for (const error of errors) {
        console.log(`   → ${error}`);
      }
    }
  }

  console.log('');
  return allValid;
};

const cmdOutputs = async (stacks, options) => {
  const { stage = 'dev' } = options;

  for (const stackName of stacks) {
    const def = STACK_DEFINITIONS[stackName];
    if (!def?.providesOutputs) continue;

    const outputDir = join(OUTPUTS_DIR, stackName);
    const outputFile = join(outputDir, 'outputs.json');

    await runCdktf(
      ['output', '--outputs-file', outputFile, stackName],
      { stage, step: `Pulling outputs for ${stackName}` }
    );
  }
};

const cmdDeploy = async (stacks, options) => {
  const { stage = 'dev', dryRun = false, autoApprove = false, force = false, acknowledgeStale = false } = options;
  const stageLabel = stage === 'production' ? 'production' : 'development';

  // Topologically sort stacks
  const sorted = topologicalSort(stacks);

  console.log(`\n${LOG_PREFIX} === Deployment Plan ===`);
  console.log(`Stacks to deploy (in order):`);
  for (const stack of sorted) {
    console.log(`  → ${stack}`);
  }
  console.log('');

  // Validate
  const valid = cmdValidate(sorted);
  if (!valid && !force) {
    console.log(`${LOG_PREFIX} ❌ Validation failed. Use --force to skip validation.`);
    process.exit(1);
  }

  // AC3.1: Freshness gate -- check artifacts before deploying
  // AC3.4: --force does NOT bypass freshness (intentional design)
  if (!acknowledgeStale) {
    let hasStale = false;
    for (const stackName of sorted) {
      const def = STACK_DEFINITIONS[stackName];
      if (!def) continue;
      for (const artifact of def.requiredArtifacts) {
        const artifactFullPath = join(DIST_DIR, artifact);
        const sourceDirs = ARTIFACT_SOURCE_DIRS[artifact];
        if (!sourceDirs) continue;
        const resolvedSourceDirs = sourceDirs.map((dir) => join(REPO_ROOT, dir));
        const result = checkArtifactFreshness(artifactFullPath, resolvedSourceDirs);
        if (result.stale) {
          hasStale = true;
          // AC3.2: Show artifact timestamp, source timestamp, and time delta
          const artifactTime = result.artifactMtime ? formatTimestamp(result.artifactMtime) : 'missing';
          const sourceTime = result.newestSourceMtime ? formatTimestamp(result.newestSourceMtime) : 'unknown';
          const delta = result.delta > 0 ? formatTimeDelta(result.delta) : 'N/A';
          console.error(`${LOG_PREFIX} STALE ARTIFACT: ${artifact}`);
          console.error(`${LOG_PREFIX}   Artifact built: ${artifactTime}`);
          console.error(`${LOG_PREFIX}   Source changed: ${sourceTime}`);
          console.error(`${LOG_PREFIX}   Delta: ${delta}`);
          if (result.newestSourcePath) {
            console.error(`${LOG_PREFIX}   Newest source: ${result.newestSourcePath}`);
          }
        }
      }
    }
    if (hasStale) {
      console.error(`\n${LOG_PREFIX} Deploy blocked: stale artifact(s) detected.`);
      console.error(`${LOG_PREFIX} Rebuild with: node scripts/cdk.mjs build`);
      console.error(`${LOG_PREFIX} Or bypass with: --acknowledge-stale`);
      process.exit(1);
    }
  }

  // Deploy each stack
  for (const stackName of sorted) {
    if (dryRun) {
      console.log(`${LOG_PREFIX} [dry-run] Would deploy: ${stackName} (${stageLabel})`);
      continue;
    }

    const args = ['deploy', stackName];
    if (autoApprove) {
      args.push('--auto-approve');
    }

    await runCdktf(args, {
      stage,
      step: `Deploying ${stackName} to ${stageLabel}`,
    });

    // Pull outputs after successful deployment
    const def = STACK_DEFINITIONS[stackName];
    if (def?.providesOutputs) {
      await cmdOutputs([stackName], { stage });
    }
  }

  console.log(`\n${LOG_PREFIX} ✅ Deployment complete!`);
};

const cmdBuild = async (options) => {
  const { noCache = true } = options;
  const buildCmd = noCache ? 'build:no-cache' : 'build';

  await runCommand('npm', ['run', buildCmd], {
    step: 'Building all packages',
  });

  await runCommand('npm', ['-w', '@cdk/platform-cdk', 'run', 'copy-assets-for-cdk'], {
    step: 'Copying Lambda and website assets for CDK',
  });
};

const cmdPrepare = async (options) => {
  const { stage = 'dev', noCache = true } = options;

  console.log(`\n${LOG_PREFIX} === Full Preparation ===\n`);

  await cmdBuild({ noCache });

  // Pull outputs for deployed stacks
  const state = getSystemState();
  const deployedStacks = Object.entries(state.outputs)
    .filter(([, exists]) => exists)
    .map(([name]) => name);

  if (deployedStacks.length > 0) {
    console.log(`\n${LOG_PREFIX} Refreshing outputs for deployed stacks...`);
    await cmdOutputs(deployedStacks, { stage });
  }

  console.log(`\n${LOG_PREFIX} ✅ Preparation complete!`);
  cmdStatus();
};

const cmdSynth = async (options) => {
  const { stage = 'dev' } = options;
  await runCdktf(['synth'], { stage, step: 'Synthesizing Terraform configuration' });
};

const cmdList = async (options) => {
  const { stage = 'dev' } = options;
  await runCdktf(['list'], { stage, step: 'Listing available stacks' });
};

const cmdDestroy = async (stacks, options) => {
  const { stage = 'dev', autoApprove = false } = options;
  const stageLabel = stage === 'production' ? 'production' : 'development';

  for (const stackName of stacks) {
    const args = ['destroy', stackName];
    if (autoApprove) {
      args.push('--auto-approve');
    }

    await runCdktf(args, {
      stage,
      step: `Destroying ${stackName} in ${stageLabel}`,
    });
  }
};

const cmdBootstrap = async (options) => {
  const { stage = 'dev', autoApprove = false } = options;
  const stageLabel = stage === 'production' ? 'production' : 'development';
  const stacksFile = join(CDK_ROOT, 'src', 'stacks.ts');

  console.log(`\n${LOG_PREFIX} === Bootstrap Backend ===\n`);
  console.log(`${LOG_PREFIX} Bootstrapping CDKTF backend for ${stageLabel}...`);

  // Read current stacks.ts
  const originalContent = readFileSync(stacksFile, 'utf-8');
  const hasMigrateTrue = originalContent.includes('migrateStateToBootstrappedBackend: true');

  try {
    // Step 1: Set migrate flag to false
    if (hasMigrateTrue) {
      console.log(`${LOG_PREFIX} Setting migrateStateToBootstrappedBackend to false...`);
      const modifiedContent = originalContent.replace(
        'migrateStateToBootstrappedBackend: true',
        'migrateStateToBootstrappedBackend: false'
      );
      writeFileSync(stacksFile, modifiedContent);
    }

    // Step 2: Deploy bootstrap stack with local state
    const args = ['deploy', 'myapp-bootstrap-stack'];
    if (autoApprove) {
      args.push('--auto-approve');
    }

    await runCdktf(args, {
      stage,
      step: 'Deploying bootstrap stack (creating S3 bucket and DynamoDB lock table)',
    });

    // Step 3: Set migrate flag back to true
    if (hasMigrateTrue) {
      console.log(`${LOG_PREFIX} Setting migrateStateToBootstrappedBackend back to true...`);
      writeFileSync(stacksFile, originalContent);
    }

    // Step 4: Clean up local state file
    const localStateFile = join(CDK_ROOT, 'terraform.myapp-bootstrap-stack.tfstate');
    if (existsSync(localStateFile)) {
      console.log(`${LOG_PREFIX} Removing local state file...`);
      unlinkSync(localStateFile);
    }

    console.log(`\n${LOG_PREFIX} ✅ Bootstrap complete!`);
    console.log(`${LOG_PREFIX} The S3 backend is now ready for use.`);

  } catch (error) {
    // Restore original file on error
    if (hasMigrateTrue) {
      writeFileSync(stacksFile, originalContent);
    }
    throw error;
  }
};

// ============================================================================
// Helpers
// ============================================================================

const topologicalSort = (stacks) => {
  const allStacks = new Set(stacks);

  const addDependencies = (stackName) => {
    const def = STACK_DEFINITIONS[stackName];
    if (!def) return;
    for (const dep of def.dependencies) {
      if (!allStacks.has(dep)) {
        allStacks.add(dep);
        addDependencies(dep);
      }
    }
  };

  for (const stack of stacks) {
    addDependencies(stack);
  }

  const sorted = [];
  const visited = new Set();
  const visiting = new Set();

  const visit = (stackName) => {
    if (visited.has(stackName)) return;
    if (visiting.has(stackName)) {
      throw new Error(`Circular dependency detected at ${stackName}`);
    }

    visiting.add(stackName);
    const def = STACK_DEFINITIONS[stackName];
    if (def) {
      for (const dep of def.dependencies) {
        if (allStacks.has(dep)) {
          visit(dep);
        }
      }
    }
    visiting.delete(stackName);
    visited.add(stackName);
    sorted.push(stackName);
  };

  for (const stack of allStacks) {
    visit(stack);
  }

  return sorted;
};

const resolveStacks = (identifier) => {
  if (DEPLOYMENT_GROUPS[identifier]) {
    return DEPLOYMENT_GROUPS[identifier];
  }

  if (STACK_DEFINITIONS[identifier]) {
    return [identifier];
  }

  const matches = Object.keys(STACK_DEFINITIONS).filter((name) =>
    name.includes(identifier)
  );

  if (matches.length === 1) {
    return matches;
  }

  if (matches.length > 1) {
    throw new Error(
      `Ambiguous identifier "${identifier}". Matches: ${matches.join(', ')}`
    );
  }

  throw new Error(
    `Unknown stack or group: ${identifier}. Use --help to see available options.`
  );
};

// ============================================================================
// Argument Parsing
// ============================================================================

const parseArgs = (rawArgs) => {
  const args = [];
  let stage = 'dev';
  let dryRun = false;
  let force = false;
  let noCache = true;
  let autoApprove = false;
  let acknowledgeStale = false;
  let help = false;

  for (const arg of rawArgs) {
    switch (arg) {
      case '--prod':
      case '--production':
        stage = 'production';
        break;
      case '--dev':
      case '--development':
        stage = 'dev';
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--force':
        force = true;
        break;
      case '--no-cache':
        noCache = true;
        break;
      case '--cache':
        noCache = false;
        break;
      case '--auto-approve':
        autoApprove = true;
        break;
      case '--acknowledge-stale':
        acknowledgeStale = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        args.push(arg);
    }
  }

  return { args, stage, dryRun, force, noCache, autoApprove, acknowledgeStale, help };
};

// ============================================================================
// Usage
// ============================================================================

const usage = () => {
  console.log(
    [
      'Usage: node scripts/cdk.mjs <command> [options]',
      '',
      'Commands:',
      '  status                  Show current state of outputs and artifacts',
      '  validate <stack|group>  Check if prerequisites are met',
      '  deploy <stack|group>    Deploy stacks with dependency handling',
      '  outputs <stack|group>   Pull outputs for deployed stacks',
      '  build                   Build all apps and copy assets',
      '  prepare                 Full preparation: build + copy + pull outputs',
      '  synth                   Synthesize Terraform configuration',
      '  list                    List available stacks',
      '  destroy <stack|group>   Destroy stacks',
      '  bootstrap               Bootstrap the CDKTF backend (S3 + DynamoDB)',
      '',
      'Stacks:',
      ...Object.entries(STACK_DEFINITIONS).map(
        ([name, def]) => `  ${name.padEnd(45)} ${def.description}`
      ),
      '',
      'Groups:',
      '  infra     Infrastructure stacks (api-stack, analytics-stack)',
      '  lambdas   Lambda stacks (api-lambda-stack, analytics-lambda-stack)',
      '  website   Client website stack',
      '  all       All stacks in correct order',
      '',
      'Options:',
      '  --prod, --production  Target production environment (default: dev)',
      '  --dev, --development  Target development environment',
      '  --dry-run             Show what would be done without executing',
      '  --force               Force deployment even if validation fails',
      '  --no-cache            Disable Turborepo cache for builds (default)',
      '  --cache               Enable Turborepo cache for builds',
      '  --auto-approve        Skip interactive approval prompts',
      '  --acknowledge-stale   Deploy even if artifacts are older than source files',
      '  -h, --help            Show this help message',
      '',
      'Examples:',
      '  node scripts/cdk.mjs status',
      '  node scripts/cdk.mjs deploy infra --auto-approve',
      '  node scripts/cdk.mjs deploy all --prod --auto-approve',
      '  node scripts/cdk.mjs outputs infra',
      '  node scripts/cdk.mjs bootstrap --auto-approve',
    ].join('\n')
  );
};

// ============================================================================
// Main
// ============================================================================

const main = async () => {
  const { args, stage, dryRun, force, noCache, autoApprove, acknowledgeStale, help } = parseArgs(
    process.argv.slice(2)
  );

  if (help || args.length === 0) {
    usage();
    process.exit(help ? 0 : 1);
  }

  const command = args.shift();

  try {
    switch (command) {
      case 'status':
        cmdStatus();
        break;

      case 'validate': {
        const target = args.shift();
        if (!target) {
          throw new Error('Missing stack or group identifier');
        }
        const stacks = resolveStacks(target);
        const sorted = topologicalSort(stacks);
        const valid = cmdValidate(sorted);
        process.exit(valid ? 0 : 1);
      }

      case 'deploy': {
        const target = args.shift();
        if (!target) {
          throw new Error('Missing stack or group identifier');
        }
        const stacks = resolveStacks(target);
        await cmdDeploy(stacks, { stage, dryRun, autoApprove, force, acknowledgeStale });
        break;
      }

      case 'outputs': {
        const target = args.shift();
        if (!target) {
          throw new Error('Missing stack or group identifier');
        }
        const stacks = resolveStacks(target);
        await cmdOutputs(stacks, { stage });
        break;
      }

      case 'build':
        await cmdBuild({ noCache });
        break;

      case 'prepare':
        await cmdPrepare({ stage, noCache });
        break;

      case 'synth':
        await cmdSynth({ stage });
        break;

      case 'list':
        await cmdList({ stage });
        break;

      case 'destroy': {
        const target = args.shift();
        if (!target) {
          throw new Error('Missing stack or group identifier');
        }
        const stacks = resolveStacks(target);
        await cmdDestroy(stacks, { stage, autoApprove });
        break;
      }

      case 'bootstrap':
        await cmdBootstrap({ stage, autoApprove });
        break;

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} ❌ ${error.message}`);
    process.exit(1);
  }
};

main();
