#!/usr/bin/env node

import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CDK_SOURCE_ROOT = join(REPO_ROOT, 'cdk', 'platform-cdk', 'src');
const STACKS_FILE = join(CDK_SOURCE_ROOT, 'stacks.ts');
const STACK_NAMES_FILE = join(CDK_SOURCE_ROOT, 'stacks', 'names.ts');
const CONSTANTS_FILE = join(CDK_SOURCE_ROOT, 'constants.ts');

const FLAG_REGEX = /(migrateStateToBootstrappedBackend:\s*)(true|false)/;
const STACK_PREFIX_REGEX =
  /export const STACK_PREFIX\s*=\s*['"`]([^'"`]+)['"`]/;
const STACK_ENTRY_REGEX =
  /{\s*name:\s*([A-Z0-9_]+)\s*,[\s\S]*?description:\s*(['"`])([^'"`]+)\2/g;
const STACK_NAME_TEMPLATE_REGEX =
  /export const (\w+)\s*=\s*`\${STACK_PREFIX}([^`]+)`/g;

const LOG_PREFIX = '[manage-cdktf-state]';

const usage = () => {
  console.log(
    [
      'Usage: node scripts/manage-cdktf-state.mjs <command>',
      '',
      'Commands:',
      '  bootstrap-backend         Deploys the bootstrap stack, migrates state, and removes the local tfstate file.',
      '  copy-assets-for-cdk       Runs the asset copy script for the platform CDK stacks.',
      '  cdk list                  Lists available stacks with descriptions.',
      '  cdk deploy <stack> [--prod]  Deploys the specified stack (defaults to dev).',
      '  cdk output <stack> [--prod]  Writes CDK outputs for the specified stack (defaults to dev).',
      '                              Omitting <stack> in a TTY launches an interactive picker for cdk deploy/output.',
      '                              Append "--" to forward extra CDK args to every selected stack.',
      '',
      'Flags:',
      '  -h, --help                Show this help message.',
      '  --prod                    Target production (cdk deploy/output).',
      '  --auto-approve            Skip interactive approval prompts (for CI/non-TTY).',
    ].join('\n'),
  );
};

const readStacksFlag = async () => {
  const content = await readFile(STACKS_FILE, 'utf8');
  const match = content.match(FLAG_REGEX);
  if (!match) {
    throw new Error(
      'Unable to locate migrateStateToBootstrappedBackend in stacks.ts.',
    );
  }
  return {
    currentValue: match[2] === 'true',
    content,
  };
};

const setStacksFlag = async (value) => {
  const { currentValue, content } = await readStacksFlag();
  if (currentValue === value) {
    return false;
  }

  const updatedContent = content.replace(
    FLAG_REGEX,
    (_, prefix) => `${prefix}${value ? 'true' : 'false'}`,
  );

  if (updatedContent === content) {
    throw new Error('Failed to update migrateStateToBootstrappedBackend flag.');
  }

  await writeFile(STACKS_FILE, updatedContent, 'utf8');
  return true;
};

const withFlagValue = async (value) => {
  const changed = await setStacksFlag(value);
  const valueLabel = value ? 'true' : 'false';
  if (changed) {
    console.log(
      `${LOG_PREFIX} Updated migrateStateToBootstrappedBackend => ${valueLabel}.`,
    );
  } else {
    console.log(
      `${LOG_PREFIX} migrateStateToBootstrappedBackend already ${valueLabel}.`,
    );
  }
};

const getStackPrefix = async () => {
  const content = await readFile(CONSTANTS_FILE, 'utf8');
  const match = content.match(STACK_PREFIX_REGEX);
  if (!match) {
    throw new Error(
      'Unable to resolve STACK_PREFIX from constants.ts. Expected `export const STACK_PREFIX = "<prefix>";`.',
    );
  }
  return match[1];
};

const readStackNameMap = async () => {
  const [stackPrefix, content] = await Promise.all([
    getStackPrefix(),
    readFile(STACK_NAMES_FILE, 'utf8'),
  ]);

  const map = new Map();
  let match;
  while ((match = STACK_NAME_TEMPLATE_REGEX.exec(content))) {
    const constName = match[1];
    const suffix = match[2];
    map.set(constName, `${stackPrefix}${suffix}`);
  }

  if (map.size === 0) {
    throw new Error(
      'Unable to resolve stack names from stacks/names.ts; no STACK_PREFIX template literals matched.',
    );
  }

  return map;
};

const readStackMetadata = async () => {
  const [stackNameMap, content] = await Promise.all([
    readStackNameMap(),
    readFile(STACKS_FILE, 'utf8'),
  ]);

  const stacks = [];
  let match;
  while ((match = STACK_ENTRY_REGEX.exec(content))) {
    const constName = match[1];
    const description = match[3].trim();
    const stackName = stackNameMap.get(constName);
    if (!stackName) {
      throw new Error(
        `Unable to resolve stack name for constant ${constName}. Update stacks/names.ts parsing logic.`,
      );
    }
    stacks.push({
      constName,
      stackName,
      description,
    });
  }

  if (stacks.length === 0) {
    throw new Error(
      'Unable to compute stacks metadata from stacks.ts; no entries matched.',
    );
  }

  return stacks;
};

const ensureInteractiveTerminal = () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Interactive stack selection requires an interactive terminal. Provide a stack identifier when running non-interactively.',
    );
  }
};

const formatStackOptionLine = (stack, index) =>
  `  ${String(index + 1).padStart(2, ' ')}. ${stack.stackName} (${stack.constName}) - ${stack.description}`;

const findStackByIdentifier = (stacks, identifier) => {
  const normalized = identifier.toLowerCase();
  return stacks.find(
    (entry) =>
      entry.stackName.toLowerCase() === normalized ||
      entry.constName.toLowerCase() === normalized,
  );
};

const promptForStackSelection = async (stacks, { stageLabel, subcommand }) => {
  ensureInteractiveTerminal();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log(
      `${LOG_PREFIX} Interactive cdk ${subcommand} mode (${stageLabel} stage). Select one or more stacks.`,
    );
    for (const [index, stack] of stacks.entries()) {
      console.log(formatStackOptionLine(stack, index));
    }

    while (true) {
      const rawAnswer = (
        await rl.question(
          'Enter stack numbers or names (comma-separated, "all" for every stack, or "q" to exit): ',
        )
      ).trim();

      if (!rawAnswer) {
        console.log(`${LOG_PREFIX} Please select at least one stack.`);
        continue;
      }

      const normalized = rawAnswer.toLowerCase();
      if (normalized === 'q' || normalized === 'quit') {
        throw new Error('Stack selection aborted by user.');
      }

      let selectedStacks;
      if (normalized === 'all') {
        selectedStacks = [...stacks];
      } else {
        const tokens = rawAnswer.split(/[,\s]+/).filter(Boolean);
        const deduped = [];
        const seen = new Set();
        let invalidToken = null;

        for (const token of tokens) {
          let stack;
          if (/^\d+$/.test(token)) {
            const index = Number(token);
            stack = stacks[index - 1];
          } else {
            stack = findStackByIdentifier(stacks, token);
          }

          if (!stack) {
            invalidToken = token;
            break;
          }

          if (!seen.has(stack.stackName)) {
            deduped.push(stack);
            seen.add(stack.stackName);
          }
        }

        if (invalidToken) {
          console.log(
            `${LOG_PREFIX} Unable to resolve stack "${invalidToken}". Use the stack name, constant, or number shown above.`,
          );
          continue;
        }

        selectedStacks = deduped;
      }

      if (selectedStacks.length === 0) {
        console.log(`${LOG_PREFIX} Please select at least one stack.`);
        continue;
      }

      const summary = selectedStacks.map((stack) => stack.stackName).join(', ');
      const confirmation = (
        await rl.question(
          `Run cdk ${subcommand} for [${summary}] in ${stageLabel} stage? (y/N): `,
        )
      )
        .trim()
        .toLowerCase();

      if (confirmation === 'q' || confirmation === 'quit') {
        throw new Error('Stack selection aborted by user.');
      }

      if (confirmation === 'y' || confirmation === 'yes') {
        return selectedStacks;
      }

      console.log(
        `${LOG_PREFIX} Selection cancelled. Choose different stacks or press Ctrl+C to exit.`,
      );
    }
  } finally {
    rl.close();
  }
};

const parseStackArguments = (args) => {
  let isProd = false;
  const positional = [];
  const passthroughArgs = [];
  let forwarding = false;

  for (const arg of args) {
    if (!forwarding && arg === '--prod') {
      isProd = true;
      continue;
    }

    if (!forwarding && arg === '--') {
      forwarding = true;
      continue;
    }

    if (forwarding) {
      passthroughArgs.push(arg);
      continue;
    }

    positional.push(arg);
  }

  return { positional, passthroughArgs, isProd };
};

const resolveStackArgs = async (args, subcommand, { allowInteractive = false } = {}) => {
  const { positional, passthroughArgs, isProd } = parseStackArguments(args);
  const stacks = await readStackMetadata();
  const stageLabel = isProd ? 'production' : 'development';

  if (positional.length === 0) {
    if (!allowInteractive) {
      throw new Error(
        `Missing stack identifier. Usage: node scripts/manage-cdktf-state.mjs cdk ${subcommand} <stack> [--prod]`,
      );
    }

    const selectedStacks = await promptForStackSelection(stacks, {
      stageLabel,
      subcommand,
    });

    return {
      stacks: selectedStacks,
      extraArgs: passthroughArgs,
      isProd,
    };
  }

  const [stackIdentifier, ...rest] = positional;
  const stack = findStackByIdentifier(stacks, stackIdentifier);

  if (!stack) {
    const available = stacks.map((entry) => entry.stackName).join(', ');
    throw new Error(
      `Unknown stack "${stackIdentifier}". Available stacks: ${available}`,
    );
  }

  return {
    stacks: [stack],
    extraArgs: [...rest, ...passthroughArgs],
    isProd,
  };
};

const runCommand = (command, args, { env, step } = {}) =>
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
        rejectPromise(
          new Error(
            `Command "${display}" terminated with signal ${signal.toString()}.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        rejectPromise(
          new Error(`Command "${display}" exited with code ${code}.`),
        );
        return;
      }
      resolvePromise();
    });
  });

const removeLocalTfState = async (stackName) => {
  const targets = [
    join(
      REPO_ROOT,
      'cdk',
      'platform-cdk',
      `terraform.${stackName}.tfstate`,
    ),
    join(
      REPO_ROOT,
      'cdk',
      'platform-cdk',
      'cdktf.out',
      'stacks',
      stackName,
      '.terraform',
      'terraform.tfstate',
    ),
  ];

  for (const target of targets) {
    await rm(target, { force: true });
    console.log(
      `${LOG_PREFIX} Removed local Terraform state file (if present): ${relative(
        REPO_ROOT,
        target,
      )}`,
    );
  }
};

const bootstrapBackend = async ({ autoApprove = false } = {}) => {
  const stackPrefix = await getStackPrefix();
  const bootstrapStackName = `${stackPrefix}-bootstrap-stack`;
  console.log(
    `${LOG_PREFIX} Derived bootstrap stack name: ${bootstrapStackName}.`,
  );

  const { currentValue: originalFlag } = await readStacksFlag();
  console.log(
    `${LOG_PREFIX} Current migrateStateToBootstrappedBackend value: ${originalFlag}.`,
  );

  let caughtError;

  try {
    await withFlagValue(false);

    // Build deploy command args, appending --auto-approve if needed
    const deployArgs = [
      '-w',
      '@cdk/platform-cdk',
      'run',
      'cdk:deploy:dev',
      bootstrapStackName,
    ];
    if (autoApprove) {
      deployArgs.push('--', '--auto-approve');
    }

    await runCommand(
      'npm',
      deployArgs,
      {
        env: { STACK: bootstrapStackName },
        step: 'Deploying bootstrap stack',
      },
    );

    await withFlagValue(true);

    await runCommand(
      'npm',
      ['-w', '@cdk/platform-cdk', 'run', 'cdk:synth:dev'],
      {
        env: { STACK: bootstrapStackName },
        step: 'Synthesizing stacks',
      },
    );

    await runCommand(
      'npm',
      ['-w', '@cdk/platform-cdk', 'run', 'cdk:bootstrap:migrate:dev'],
      {
        step: 'Migrating Terraform state',
      },
    );

    await removeLocalTfState(bootstrapStackName);
  } catch (error) {
    caughtError = error;
  } finally {
    try {
      await withFlagValue(originalFlag);
    } catch (restoreError) {
      console.error(
        `${LOG_PREFIX} Failed to restore migrateStateToBootstrappedBackend => ${originalFlag}:`,
        restoreError,
      );
      if (!caughtError) {
        caughtError = restoreError;
      }
    }
  }

  if (caughtError) {
    throw caughtError;
  }

  console.log(
    `${LOG_PREFIX} Bootstrap backend workflow completed successfully.`,
  );
};

const handleCdkList = async () => {
  const stacks = await readStackMetadata();
  console.log(`${LOG_PREFIX} Available stacks:`);
  for (const stack of stacks) {
    console.log(`  - ${stack.stackName}: ${stack.description}`);
  }
};

const handleCdkDeploy = async (args) => {
  const { stacks, extraArgs, isProd } = await resolveStackArgs(args, 'deploy', {
    allowInteractive: true,
  });
  const stage = isProd ? 'prod' : 'dev';
  const stageLabel = isProd ? 'production' : 'development';
  const scriptName = `cdk:deploy:${stage}`;

  for (const stack of stacks) {
    const npmArgs = [
      '-w',
      '@cdk/platform-cdk',
      'run',
      scriptName,
      stack.stackName,
      ...extraArgs,
    ];

    await runCommand('npm', npmArgs, {
      env: { STACK: stack.stackName },
      step: `Deploying ${stageLabel} stack ${stack.stackName}`,
    });
  }
};

const handleCdkOutput = async (args) => {
  const { stacks, extraArgs, isProd } = await resolveStackArgs(args, 'output', {
    allowInteractive: true,
  });
  const stage = isProd ? 'prod' : 'dev';
  const stageLabel = isProd ? 'production' : 'development';
  const scriptName = `cdk:output:${stage}`;

  for (const stack of stacks) {
    const npmArgs = [
      '-w',
      '@cdk/platform-cdk',
      'run',
      scriptName,
      stack.stackName,
      ...extraArgs,
    ];

    await runCommand('npm', npmArgs, {
      env: { STACK: stack.stackName },
      step: `Writing ${stageLabel} stage outputs for ${stack.stackName}`,
    });
  }
};

const handleCdkCommand = async (args) => {
  const subcommand = args.shift();

  if (!subcommand) {
    throw new Error(
      'Missing CDK subcommand. Expected one of: list, deploy, output.',
    );
  }

  switch (subcommand) {
    case 'list':
      await handleCdkList();
      break;
    case 'deploy':
      await handleCdkDeploy(args);
      break;
    case 'output':
      await handleCdkOutput(args);
      break;
    default:
      throw new Error(`Unknown CDK subcommand "${subcommand}".`);
  }
};

const handleCopyAssetsForCdk = async () => {
  await runCommand(
    'npm',
    ['-w', '@cdk/platform-cdk', 'run', 'copy-assets-for-cdk'],
    { step: 'Copying assets for platform CDK stack' },
  );
};

const main = async () => {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  const autoApprove = args.includes('--auto-approve');

  const command = args.filter((a) => !a.startsWith('--')).shift();

  if (!command) {
    usage();
    process.exit(1);
  }

  switch (command) {
    case 'copy-assets-for-cdk':
      await handleCopyAssetsForCdk();
      break;
    case 'bootstrap-backend':
      await bootstrapBackend({ autoApprove });
      break;
    case 'cdk':
      await handleCdkCommand(args);
      break;
    default:
      console.error(`${LOG_PREFIX} Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
};

main().catch((error) => {
  console.error(`${LOG_PREFIX} ${error.message}`);
  process.exit(1);
});
