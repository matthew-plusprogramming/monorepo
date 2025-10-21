import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { output } from 'zod';

import { packageRootDir } from '../location';
import { stacks } from '../stacks';

type StackConfig = (typeof stacks)[number];

type BootstrapStackName = `${string}-bootstrap-stack`;
type ConsumableStackConfig = Exclude<StackConfig, { name: BootstrapStackName }>;
export type ConsumableStack = ConsumableStackConfig['name'];

type StackOutputSchema<Name extends ConsumableStack> = Extract<
  ConsumableStackConfig,
  { name: Name }
>['outputSchema'];

type StackOutput<Name extends ConsumableStack> = output<
  StackOutputSchema<Name>
>;

type StackOutputValue<Name extends ConsumableStack> = StackOutput<Name>[Name];

const parseStackOutput = <TConfig extends ConsumableStackConfig>(
  config: TConfig,
  stackName: TConfig['name'],
  rawOutput: unknown,
): StackOutput<TConfig['name']> => {
  const parsed = config.outputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    throw new Error(`Failed to parse output for stack: ${stackName}`, {
      cause: parsed.error,
    });
  }
  const data: StackOutput<TConfig['name']> = parsed.data;
  return data;
};

const generateOutputPath = (
  stack: ConsumableStack,
  outputsPath?: string,
): string => {
  if (outputsPath) {
    return resolve(outputsPath, `cdktf-outputs/stacks/${stack}/outputs.json`);
  }
  return resolve(packageRootDir, `cdktf-outputs/stacks/${stack}/outputs.json`);
};

const loadOutput = <T extends ConsumableStack>(
  stack: T,
  stackOutputPath: string,
): StackOutputValue<T> => {
  if (!existsSync(stackOutputPath)) {
    throw new Error(`Stack output file not found: ${stackOutputPath}`);
  }
  const stackOutputData = readFileSync(stackOutputPath, 'utf-8');
  const stackOutput: unknown = JSON.parse(stackOutputData);

  const stackConfig = stacks.find(
    (s): s is ConsumableStackConfig & { name: T } => s.name === stack,
  );
  if (!stackConfig) {
    throw new Error(`Unknown stack: ${stack}`);
  }

  const data = parseStackOutput(stackConfig, stack, stackOutput);
  const value: StackOutputValue<T> = data[stack];
  return value;
};

const loadedOutputs: { [K in ConsumableStack]?: StackOutputValue<K> } = {};

export const loadCDKOutput = <T extends ConsumableStack>(
  stack: T,
  outputsPath?: string,
): StackOutputValue<T> => {
  const existing = loadedOutputs[stack];
  if (existing) {
    return existing;
  }
  const output = loadOutput(stack, generateOutputPath(stack, outputsPath));
  loadedOutputs[stack] = output;
  return output;
};
