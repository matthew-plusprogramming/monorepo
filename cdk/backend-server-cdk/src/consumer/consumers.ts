import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { output } from 'zod';

import { packageRootDir } from '../location';
import { stacks } from '../stacks';

type StackConfig = (typeof stacks)[number];
type StackConfigWithoutBootstrap = Exclude<StackConfig, { name: 'bootstrap' }>;

type OutputByName = {
  [S in StackConfigWithoutBootstrap as S['name']]: output<S['outputSchema']>;
};

export type ConsumableStack = keyof OutputByName;

// Flattened output type by stack name so union keys work without double indexing
type OutputValueByName = {
  [K in keyof OutputByName]: OutputByName[K] extends Record<K, infer V>
    ? V
    : never;
};

const generateOutputPath = (
  stack: ConsumableStack,
  outputsPath?: string,
): string => {
  if (outputsPath) {
    return resolve(outputsPath, `cdktf.out/stacks/${stack}/outputs.json`);
  }
  return resolve(packageRootDir, `cdktf.out/stacks/${stack}/outputs.json`);
};

const loadOutput = <T extends ConsumableStack>(
  stack: T,
  stackOutputPath: string,
): OutputValueByName[T] => {
  if (!existsSync(stackOutputPath)) {
    throw new Error(`Stack output file not found: ${stackOutputPath}`);
  }
  const stackOutputData = readFileSync(stackOutputPath, 'utf-8');
  const stackOutput = JSON.parse(stackOutputData);

  const stackConfig = stacks.find(
    (s): s is Extract<StackConfigWithoutBootstrap, { name: T }> =>
      s.name === stack,
  );
  if (!stackConfig) {
    throw new Error(`Unknown stack: ${stack}`);
  }

  const parsed = stackConfig?.outputSchema.parse(
    stackOutput,
  ) as OutputByName[T];

  if (!parsed) {
    throw new Error(`Failed to parse output for stack: ${stack}`);
  }

  return (parsed as Record<T, OutputValueByName[T]>)[stack];
};

const loadedOutputs: { [K in ConsumableStack]?: OutputValueByName[K] } = {};

export const loadCDKOutput = <T extends ConsumableStack>(
  stack: T,
  outputsPath?: string,
): OutputValueByName[T] => {
  if (!loadedOutputs[stack]) {
    loadedOutputs[stack] = loadOutput<typeof stack>(
      stack,
      generateOutputPath(stack, outputsPath),
    );
  }
  return loadedOutputs[stack]!;
};
