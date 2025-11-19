import { existsSync } from 'node:fs';

import '@dotenvx/dotenvx/config';

import { App } from 'cdktf';

import type { ArtifactRequirement } from './lambda/artifacts';
import type { AnyStack } from './types/stack';
import { STACK_PREFIX } from './constants';
import { stacks } from './stacks';

const isArtifactRequirement = (
  value: unknown,
): value is ArtifactRequirement => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.description === 'string'
  );
};

const region = process.env.AWS_REGION;

const parseCliStackArgs = (): string[] => {
  const args = process.argv.slice(2);
  const firstArg = args[0];

  if (
    firstArg &&
    (firstArg.endsWith('.ts') ||
      firstArg.endsWith('.tsx') ||
      firstArg.endsWith('.js') ||
      firstArg.endsWith('.jsx'))
  ) {
    args.shift();
  }

  return args.filter((arg) => {
    if (!arg.trim()) {
      return false;
    }

    return !arg.startsWith('-');
  });
};

const getStacksFromEnv = (): string[] => {
  const stackEnv = process.env.STACK;
  if (!stackEnv) {
    return [];
  }

  return stackEnv
    .split(',')
    .map((stackName) => stackName.trim())
    .filter(Boolean);
};

const getSelectedStackNames = (): Set<string> | undefined => {
  const selectedStacksFromEnv = getStacksFromEnv();
  if (selectedStacksFromEnv.length > 0) {
    return new Set(selectedStacksFromEnv);
  }

  const stacksFromCli = parseCliStackArgs();
  if (stacksFromCli.length === 0) {
    return undefined;
  }

  return new Set(stacksFromCli);
};

const selectedStackNames = getSelectedStackNames();

if (!region) {
  throw new Error('AWS_REGION environment variable is not set');
}

const app = new App();

const collectMissingArtifacts = (
  artifacts: AnyStack['requiredArtifacts'],
): ArtifactRequirement[] => {
  if (!Array.isArray(artifacts)) {
    return [];
  }

  const missing: ArtifactRequirement[] = [];

  for (const artifact of artifacts) {
    if (!isArtifactRequirement(artifact)) {
      continue;
    }

    if (!existsSync(artifact.path)) {
      missing.push(artifact);
    }
  }

  return missing;
};

const instantiateStack = (
  stack: AnyStack,
  appContext: App,
  stackRegion: string,
): void => {
  const { Stack } = stack;

  if (
    stack.name !== `${STACK_PREFIX}-bootstrap-stack` &&
    Array.isArray(stack.stages)
  ) {
    let hasValidStage = false;

    for (const stage of stack.stages) {
      if (typeof stage !== 'string') {
        continue;
      }

      hasValidStage = true;
      new Stack(appContext, `${stack.name}-${stage}`, {
        region: stackRegion,
        ...stack.props,
      });
    }

    if (hasValidStage) {
      return;
    }
  }

  new Stack(appContext, stack.name, {
    region: stackRegion,
    ...stack.props,
  });
};

for (const stack of stacks) {
  if (selectedStackNames && !selectedStackNames.has(stack.name)) {
    continue;
  }

  const missingArtifacts = collectMissingArtifacts(
    'requiredArtifacts' in stack ? stack.requiredArtifacts : [],
  );
  if (missingArtifacts.length > 0) {
    console.warn(
      `⚠️  Skipping stack "${stack.name}" because required artifacts were not found:`,
    );
    for (const artifact of missingArtifacts) {
      console.warn(`  - ${artifact.description} (${artifact.path})`);
    }
    continue;
  }

  instantiateStack(stack, app, region);
}

app.synth();
