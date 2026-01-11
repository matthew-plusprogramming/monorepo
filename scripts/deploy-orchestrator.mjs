#!/usr/bin/env node

/**
 * CDK Deploy Orchestrator
 *
 * A smart orchestration script that handles the complex build/deploy flow
 * by detecting the current state and determining the minimum steps needed.
 *
 * Key features:
 * - Detects what outputs exist vs what's needed
 * - Detects what artifacts are built vs what's needed
 * - Determines the correct deployment order
 * - Fails fast on missing prerequisites (no silent skipping)
 * - Provides clear guidance on what needs to happen
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CDK_ROOT = join(REPO_ROOT, 'cdk', 'platform-cdk');
const OUTPUTS_DIR = join(CDK_ROOT, 'cdktf-outputs', 'stacks');
const DIST_DIR = join(CDK_ROOT, 'dist');

const LOG_PREFIX = '[deploy-orchestrator]';

// Stack definitions with their dependencies and artifacts
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

// Deployment groups for common operations
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

const usage = () => {
  console.log(
    [
      'Usage: node scripts/deploy-orchestrator.mjs <command> [options]',
      '',
      'Commands:',
      '  status                  Show current state of outputs and artifacts',
      '  validate <stack|group>  Check if prerequisites are met for deployment',
      '  plan <stack|group>      Show what steps would be executed',
      '  deploy <stack|group>    Deploy with automatic prerequisite handling',
      '  outputs <stack|group>   Pull outputs for deployed stacks',
      '  build                   Build all apps with no cache',
      '  prepare                 Full preparation: build → copy assets → pull outputs',
      '',
      'Stacks:',
      ...Object.entries(STACK_DEFINITIONS).map(
        ([name, def]) => `  ${name.padEnd(32)} ${def.description}`
      ),
      '',
      'Groups:',
      '  infra     Infrastructure stacks (api-stack, analytics-stack)',
      '  lambdas   Lambda stacks (api-lambda-stack, analytics-lambda-stack)',
      '  website   Client website stack',
      '  all       All stacks in correct order',
      '',
      'Options:',
      '  --prod          Target production environment',
      '  --dry-run       Show what would be done without executing',
      '  --force         Force rebuild even if artifacts exist',
      '  --no-cache      Disable Turborepo cache for builds',
      '  --auto-approve  Skip interactive approval prompts (for CI/non-TTY)',
      '  -h, --help      Show this help message',
    ].join('\n')
  );
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

  // Check app builds
  appBuilds['node-server'] = checkAppDistExists('node-server');
  appBuilds['analytics-lambda'] = checkAppDistExists('analytics-lambda');
  appBuilds['client-website'] = existsSync(join(REPO_ROOT, 'apps', 'client-website', 'out'));

  return { outputs, artifacts, appBuilds };
};

const printStatus = () => {
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

// ============================================================================
// Validation
// ============================================================================

const validateStackDeployable = (stackName) => {
  const def = STACK_DEFINITIONS[stackName];
  if (!def) {
    return { valid: false, errors: [`Unknown stack: ${stackName}`] };
  }

  const errors = [];
  const state = getSystemState();

  // Check required outputs
  for (const requiredOutput of def.requiredOutputs) {
    if (!state.outputs[requiredOutput]) {
      errors.push(
        `Missing output from ${requiredOutput}. Run: node scripts/deploy-orchestrator.mjs outputs ${requiredOutput}`
      );
    }
  }

  // Check required artifacts
  for (const artifact of def.requiredArtifacts) {
    if (!state.artifacts[artifact]) {
      errors.push(
        `Missing artifact: ${artifact}. Run: node scripts/deploy-orchestrator.mjs build`
      );
    }
  }

  return { valid: errors.length === 0, errors };
};

const validateDeployment = (stacks) => {
  console.log(`\n${LOG_PREFIX} === Validation ===\n`);

  let allValid = true;
  const results = {};

  for (const stackName of stacks) {
    const result = validateStackDeployable(stackName);
    results[stackName] = result;

    if (result.valid) {
      console.log(`✅ ${stackName}: Ready to deploy`);
    } else {
      allValid = false;
      console.log(`❌ ${stackName}: Not ready`);
      for (const error of result.errors) {
        console.log(`   → ${error}`);
      }
    }
  }

  console.log('');
  return { valid: allValid, results };
};

// ============================================================================
// Command Execution
// ============================================================================

const runCommand = (command, args = [], { step, env = {} } = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const display = [command, ...args].join(' ');
    if (step) {
      console.log(`\n${LOG_PREFIX} ${step}`);
    }
    console.log(`${LOG_PREFIX} $ ${display}`);

    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...env },
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

// ============================================================================
// Build & Prepare
// ============================================================================

const buildAll = async ({ noCache = true } = {}) => {
  const buildCmd = noCache ? 'build:no-cache' : 'build';
  await runCommand('npm', ['run', buildCmd], {
    step: 'Building all packages (no cache)',
  });
};

const copyAssets = async () => {
  await runCommand('npm', ['-w', '@cdk/platform-cdk', 'run', 'copy-assets-for-cdk'], {
    step: 'Copying Lambda and website assets for CDK',
  });
};

const pullOutputs = async (stacks, { isProd = false } = {}) => {
  const stage = isProd ? 'prod' : 'dev';

  for (const stackName of stacks) {
    const def = STACK_DEFINITIONS[stackName];
    if (!def?.providesOutputs) continue;

    await runCommand(
      'npm',
      ['-w', '@cdk/platform-cdk', 'run', `cdk:output:${stage}`, stackName],
      {
        step: `Pulling outputs for ${stackName}`,
        env: { STACK: stackName },
      }
    );
  }
};

const prepare = async ({ isProd = false, noCache = true } = {}) => {
  console.log(`\n${LOG_PREFIX} === Full Preparation ===\n`);

  // Step 1: Build all apps
  await buildAll({ noCache });

  // Step 2: Copy assets to CDK dist
  await copyAssets();

  // Step 3: Pull outputs for infrastructure stacks (if deployed)
  const state = getSystemState();
  const deployedStacks = Object.entries(state.outputs)
    .filter(([, exists]) => exists)
    .map(([name]) => name);

  if (deployedStacks.length > 0) {
    console.log(`\n${LOG_PREFIX} Refreshing outputs for deployed stacks...`);
    await pullOutputs(deployedStacks, { isProd });
  }

  console.log(`\n${LOG_PREFIX} ✅ Preparation complete!`);
  printStatus();
};

// ============================================================================
// Deployment
// ============================================================================

const deployStack = async (stackName, { isProd = false, dryRun = false, autoApprove = false } = {}) => {
  const stage = isProd ? 'prod' : 'dev';
  const stageLabel = isProd ? 'production' : 'development';

  if (dryRun) {
    console.log(`${LOG_PREFIX} [dry-run] Would deploy: ${stackName} (${stageLabel})`);
    return;
  }

  // Build the command args, appending --auto-approve after -- if needed
  const cmdArgs = ['-w', '@cdk/platform-cdk', 'run', `cdk:deploy:${stage}`, stackName];
  if (autoApprove) {
    cmdArgs.push('--', '--auto-approve');
  }

  await runCommand(
    'npm',
    cmdArgs,
    {
      step: `Deploying ${stackName} to ${stageLabel}`,
      env: { STACK: stackName },
    }
  );
};

const deployWithDependencies = async (stacks, { isProd = false, dryRun = false, force = false, autoApprove = false } = {}) => {
  // Topologically sort stacks based on dependencies
  const sorted = topologicalSort(stacks);

  console.log(`\n${LOG_PREFIX} === Deployment Plan ===`);
  console.log(`Stacks to deploy (in order):`);
  for (const stack of sorted) {
    console.log(`  → ${stack}`);
  }
  console.log('');

  // Validate all stacks first
  const validation = validateDeployment(sorted);

  if (!validation.valid && !force) {
    console.log(`${LOG_PREFIX} ❌ Validation failed. Use --force to skip validation.`);

    // Offer to run the preparation steps
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        const answer = await rl.question('Would you like to run preparation steps first? (y/N): ');
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
          rl.close();
          await prepare({ isProd });
          // Re-validate after preparation
          const revalidation = validateDeployment(sorted);
          if (!revalidation.valid) {
            console.log(`${LOG_PREFIX} ❌ Still missing prerequisites after preparation.`);
            console.log(`${LOG_PREFIX} You may need to deploy infrastructure stacks first.`);
            process.exit(1);
          }
        } else {
          rl.close();
          process.exit(1);
        }
      } catch {
        rl.close();
        process.exit(1);
      }
    } else {
      process.exit(1);
    }
  }

  // Deploy each stack
  for (const stackName of sorted) {
    await deployStack(stackName, { isProd, dryRun, autoApprove });

    // Pull outputs after successful deployment if the stack provides them
    const def = STACK_DEFINITIONS[stackName];
    if (def?.providesOutputs && !dryRun) {
      await pullOutputs([stackName], { isProd });
    }
  }

  console.log(`\n${LOG_PREFIX} ✅ Deployment complete!`);
};

const topologicalSort = (stacks) => {
  // Get all dependencies recursively
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

  // Topological sort
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

// ============================================================================
// Argument Parsing
// ============================================================================

const parseArgs = (rawArgs) => {
  const args = [];
  let isProd = false;
  let dryRun = false;
  let force = false;
  let noCache = true; // Default to no-cache
  let autoApprove = false;
  let help = false;

  for (const arg of rawArgs) {
    switch (arg) {
      case '--prod':
        isProd = true;
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
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        args.push(arg);
    }
  }

  return { args, isProd, dryRun, force, noCache, autoApprove, help };
};

const resolveStacks = (identifier) => {
  // Check if it's a group
  if (DEPLOYMENT_GROUPS[identifier]) {
    return DEPLOYMENT_GROUPS[identifier];
  }

  // Check if it's a stack
  if (STACK_DEFINITIONS[identifier]) {
    return [identifier];
  }

  // Check if it's a partial match
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
// Main
// ============================================================================

const main = async () => {
  const { args, isProd, dryRun, force, noCache, autoApprove, help } = parseArgs(
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
        printStatus();
        break;

      case 'validate': {
        const target = args.shift();
        if (!target) {
          throw new Error('Missing stack or group identifier');
        }
        const stacks = resolveStacks(target);
        const result = validateDeployment(stacks);
        process.exit(result.valid ? 0 : 1);
      }

      case 'plan': {
        const target = args.shift();
        if (!target) {
          throw new Error('Missing stack or group identifier');
        }
        const stacks = resolveStacks(target);
        const sorted = topologicalSort(stacks);
        console.log(`\n${LOG_PREFIX} Deployment plan for "${target}":`);
        for (let i = 0; i < sorted.length; i++) {
          const def = STACK_DEFINITIONS[sorted[i]];
          console.log(`  ${i + 1}. ${sorted[i]} - ${def.description}`);
        }
        console.log('');
        validateDeployment(sorted);
        break;
      }

      case 'deploy': {
        const target = args.shift();
        if (!target) {
          throw new Error('Missing stack or group identifier');
        }
        const stacks = resolveStacks(target);
        await deployWithDependencies(stacks, { isProd, dryRun, force, autoApprove });
        break;
      }

      case 'outputs': {
        const target = args.shift();
        if (!target) {
          throw new Error('Missing stack or group identifier');
        }
        const stacks = resolveStacks(target);
        await pullOutputs(stacks, { isProd });
        break;
      }

      case 'build':
        await buildAll({ noCache });
        await copyAssets();
        break;

      case 'prepare':
        await prepare({ isProd, noCache });
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
