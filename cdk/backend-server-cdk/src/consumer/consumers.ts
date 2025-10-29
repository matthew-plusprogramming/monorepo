import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { output } from 'zod';

import { packageRootDir } from '../location';
import { stacks } from '../stacks';
import { API_LAMBDA_STACK_NAME } from '../stacks/names';

type StackConfig = (typeof stacks)[number];

type BootstrapStackName = `${string}-bootstrap-stack`;
type ConsumableStackConfig = Exclude<StackConfig, { name: BootstrapStackName }>;
export type ConsumableStack = ConsumableStackConfig['name'];

type StackOutputSchema<Name extends ConsumableStack> = Extract<
  ConsumableStackConfig,
  { name: Name }
>['outputSchema'];

type StackSchemaOutput<Name extends ConsumableStack> = output<
  StackOutputSchema<Name>
>;

type NamespacedStackOutput<Name extends ConsumableStack> =
  StackSchemaOutput<Name> extends Record<Name, infer Output>
    ? StackSchemaOutput<Name> & Record<Name, Output>
    : never;

type StackOutputValue<Name extends ConsumableStack> =
  StackSchemaOutput<Name> extends Record<Name, infer Output>
    ? Output
    : StackSchemaOutput<Name>;

const isNamespacedStackOutput = <Name extends ConsumableStack>(
  stackName: Name,
  output: unknown,
): output is NamespacedStackOutput<Name> => {
  return typeof output === 'object' && output !== null && stackName in output;
};

const parseStackOutput = <Name extends ConsumableStack>(
  config: Extract<ConsumableStackConfig, { name: Name }>,
  stackName: Name,
  rawOutput: unknown,
): StackOutputValue<Name> => {
  const parsed = config.outputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    throw new Error(`Failed to parse output for stack: ${stackName}`, {
      cause: parsed.error,
    });
  }

  if (stackName === API_LAMBDA_STACK_NAME) {
    return parsed.data as StackOutputValue<Name>;
  }

  if (!isNamespacedStackOutput(stackName, parsed.data)) {
    throw new Error(`Missing output for stack: ${stackName}`);
  }

  const stackOutput = parsed.data[stackName] as StackOutputValue<Name>;
  if (!stackOutput) {
    throw new Error(`Missing output for stack: ${stackName}`);
  }
  return stackOutput;
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

const getStackConfig = <Name extends ConsumableStack>(
  stackName: Name,
): Extract<ConsumableStackConfig, { name: Name }> => {
  const stackConfig = stacks.find(
    (candidate): candidate is Extract<ConsumableStackConfig, { name: Name }> =>
      candidate.name === stackName,
  );
  if (!stackConfig) {
    throw new Error(`Unknown stack: ${stackName}`);
  }
  return stackConfig;
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

  const stackConfig = getStackConfig(stack);

  return parseStackOutput(stackConfig, stackConfig.name, stackOutput);
};

type StackOutputsMap = {
  [Name in ConsumableStack]: StackOutputValue<Name>;
};

const loadedOutputs: Partial<StackOutputsMap> = {};

export const loadCDKOutput = <T extends ConsumableStack>(
  stack: T,
  outputsPath?: string,
): StackOutputValue<T> => {
  const existing = loadedOutputs[stack];
  if (existing) {
    return existing;
  }
  const output = loadOutput(stack, generateOutputPath(stack, outputsPath));
  loadedOutputs[stack] = output as StackOutputsMap[T];
  return output;
};
