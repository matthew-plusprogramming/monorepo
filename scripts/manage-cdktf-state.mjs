#!/usr/bin/env node

import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CDK_SOURCE_ROOT = join(REPO_ROOT, 'cdk', 'backend-server-cdk', 'src');
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
      '  cdk list                  Lists available stacks with descriptions.',
      '  cdk deploy <stack> [--prod]  Deploys the specified stack (defaults to dev).',
      '',
      'Flags:',
      '  -h, --help                Show this help message.',
      '  --prod                    Deploy to production (cdk deploy).',
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
      'backend-server-cdk',
      `terraform.${stackName}.tfstate`,
    ),
    join(
      REPO_ROOT,
      'cdk',
      'backend-server-cdk',
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

const bootstrapBackend = async () => {
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

    await runCommand(
      'npm',
      [
        '-w',
        '@cdk/backend-server-cdk',
        'run',
        'cdk:deploy:dev',
        bootstrapStackName,
      ],
      {
        env: { STACK: bootstrapStackName },
        step: 'Deploying bootstrap stack',
      },
    );

    await withFlagValue(true);

    await runCommand(
      'npm',
      ['-w', '@cdk/backend-server-cdk', 'run', 'cdk:synth:dev'],
      {
        env: { STACK: bootstrapStackName },
        step: 'Synthesizing stacks',
      },
    );

    await runCommand(
      'npm',
      ['-w', '@cdk/backend-server-cdk', 'run', 'cdk:bootstrap:migrate:dev'],
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
  let isProd = false;
  const positional = [];

  for (const arg of args) {
    if (arg === '--prod') {
      isProd = true;
      continue;
    }
    positional.push(arg);
  }

  if (positional.length === 0) {
    throw new Error(
      'Missing stack identifier. Usage: node scripts/manage-cdktf-state.mjs cdk deploy <stack> [--prod]',
    );
  }

  const [stackIdentifier, ...extraArgs] = positional;
  const stacks = await readStackMetadata();

  const stack = stacks.find(
    (entry) =>
      entry.stackName === stackIdentifier ||
      entry.constName === stackIdentifier,
  );

  if (!stack) {
    const available = stacks.map((entry) => entry.stackName).join(', ');
    throw new Error(
      `Unknown stack "${stackIdentifier}". Available stacks: ${available}`,
    );
  }

  const stage = isProd ? 'prod' : 'dev';
  const scriptName = `cdk:deploy:${stage}`;
  const npmArgs = [
    '-w',
    '@cdk/backend-server-cdk',
    'run',
    scriptName,
    stack.stackName,
    ...extraArgs,
  ];

  await runCommand('npm', npmArgs, {
    env: { STACK: stack.stackName },
    step: `Deploying ${isProd ? 'production' : 'development'} stack`,
  });
};

const handleCdkCommand = async (args) => {
  const subcommand = args.shift();

  if (!subcommand) {
    throw new Error('Missing CDK subcommand. Expected one of: list, deploy.');
  }

  switch (subcommand) {
    case 'list':
      await handleCdkList();
      break;
    case 'deploy':
      await handleCdkDeploy(args);
      break;
    default:
      throw new Error(`Unknown CDK subcommand "${subcommand}".`);
  }
};

const main = async () => {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  const command = args.shift();

  if (!command) {
    usage();
    process.exit(1);
  }

  switch (command) {
    case 'bootstrap-backend':
      await bootstrapBackend();
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
