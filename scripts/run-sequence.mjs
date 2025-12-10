#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(__dirname, 'sequences.config.json');
const LOG_PREFIX = '[run-sequence]';

const usage = () => {
  console.log(
    [
      'Usage:',
      '  node scripts/run-sequence.mjs list',
      '  node scripts/run-sequence.mjs run <name> [--dry-run]',
      '',
      'Options:',
      '  -h, --help      Show this help.',
      '  --dry-run       Print steps without executing them (for run).',
    ].join('\n'),
  );
};

const validateSequence = (sequence) => {
  if (!sequence || typeof sequence !== 'object') {
    throw new Error('Invalid sequence entry in config.');
  }
  if (!sequence.name || typeof sequence.name !== 'string') {
    throw new Error('Sequence is missing a "name" string.');
  }
  if (!sequence.description || typeof sequence.description !== 'string') {
    throw new Error(`Sequence "${sequence.name}" missing "description".`);
  }
  if (!Array.isArray(sequence.steps) || sequence.steps.length === 0) {
    throw new Error(`Sequence "${sequence.name}" missing "steps" array.`);
  }
  for (const step of sequence.steps) {
    if (typeof step !== 'string' || !step.trim()) {
      throw new Error(
        `Sequence "${sequence.name}" has an empty or non-string step.`,
      );
    }
  }
};

const loadConfig = async () => {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed.sequences || !Array.isArray(parsed.sequences)) {
    throw new Error('Config is missing a "sequences" array.');
  }

  parsed.sequences.forEach(validateSequence);

  return parsed.sequences;
};

const listSequences = (sequences) => {
  console.log(`${LOG_PREFIX} Available sequences:`);
  for (const sequence of sequences) {
    console.log(`  - ${sequence.name}: ${sequence.description}`);
  }
};

const runCommand = (command, { index, total }) =>
  new Promise((resolvePromise, rejectPromise) => {
    console.log(`\n${LOG_PREFIX} Step ${index + 1}/${total}: ${command}`);

    const child = spawn(command, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: true,
      env: process.env,
    });

    child.on('error', (error) => {
      rejectPromise(error);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        rejectPromise(
          new Error(
            `Command "${command}" terminated with signal ${signal.toString()}.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const error = new Error(
          `Command "${command}" exited with code ${code}.`,
        );
        error.exitCode = code;
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });

const runSequence = async (sequence, { dryRun = false } = {}) => {
  console.log(
    `${LOG_PREFIX} Running "${sequence.name}" — ${sequence.description}${
      dryRun ? ' (dry run)' : ''
    }`,
  );

  for (let index = 0; index < sequence.steps.length; index += 1) {
    const command = sequence.steps[index];
    if (dryRun) {
      console.log(
        `${LOG_PREFIX} [dry-run] Step ${index + 1}/${
          sequence.steps.length
        }: ${command}`,
      );
      continue;
    }

    await runCommand(command, {
      index,
      total: sequence.steps.length,
    });
  }

  console.log(`${LOG_PREFIX} Sequence "${sequence.name}" completed.`);
};

const parseArgs = (rawArgs) => {
  const args = [];
  let dryRun = false;
  let helpRequested = false;

  for (const arg of rawArgs) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      helpRequested = true;
      continue;
    }
    args.push(arg);
  }

  return { args, dryRun, helpRequested };
};

const main = async () => {
  const { args, dryRun, helpRequested } = parseArgs(process.argv.slice(2));

  if (helpRequested || args.length === 0) {
    usage();
    process.exit(helpRequested ? 0 : 1);
  }

  const command = args.shift();
  const sequences = await loadConfig();

  switch (command) {
    case 'list':
      listSequences(sequences);
      break;
    case 'run': {
      const targetName = args.shift();
      if (!targetName) {
        console.error(`${LOG_PREFIX} Missing sequence name.`);
        usage();
        process.exit(1);
      }

      const target = sequences.find(
        (sequence) => sequence.name === targetName,
      );
      if (!target) {
        const available = sequences.map((sequence) => sequence.name).join(', ');
        throw new Error(
          `Unknown sequence "${targetName}". Available: ${available}`,
        );
      }

      await runSequence(target, { dryRun });
      break;
    }
    default:
      throw new Error(`Unknown command "${command}".`);
  }
};

main().catch((error) => {
  console.error(`${LOG_PREFIX} ${error.message}`);
  process.exit(1);
});
