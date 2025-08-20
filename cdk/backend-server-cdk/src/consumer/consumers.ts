import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { output } from 'zod';

import { packageRootDir } from '../location';
import { stacks } from '../stacks';

type StackConfig = (typeof stacks)[number];
type StackConfigWithoutBootstrap = Exclude<StackConfig, { name: 'bootstrap' }>;

type OutputByName = {
  [S in StackConfigWithoutBootstrap as S['name']]: output<S['outputSchema']>;
};

export type ConsumableStack = keyof OutputByName;

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
): OutputByName[T][T] => {
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

  const parsed = stackConfig?.outputSchema.parse(stackOutput);

  if (!parsed) {
    throw new Error(`Failed to parse output for stack: ${stack}`);
  }

  return parsed[stack];
};

const loadedOutputs: { [K in ConsumableStack]?: OutputByName[K][K] } = {};

export const loadCDKOutput = <T extends ConsumableStack>(
  stack: T,
  outputsPath?: string,
): OutputByName[T][T] => {
  if (!loadedOutputs[stack]) {
    loadedOutputs[stack] = loadOutput<typeof stack>(
      stack,
      generateOutputPath(stack, outputsPath),
    );
  }
  return loadedOutputs[stack]!;
};
