import fs from 'fs';
import path from 'path';
import type { output, ZodObject } from 'zod';

import type { stacks } from '../stacks';

type ConsumableStack = Exclude<(typeof stacks)[number]['name'], 'bootstrap'>;

export const loadOutput = <T extends ZodObject>(
  schema: T,
  stack: ConsumableStack,
): output<T> => {
  const stackOutputPath = path.resolve(
    __dirname,
    `../../cdktf.out/stacks/${stack}/outputs.json`,
  );

  if (!fs.existsSync(stackOutputPath)) {
    throw new Error(`Stack output file not found: ${stackOutputPath}`);
  }
  const outputData = fs.readFileSync(stackOutputPath, 'utf-8');
  const output = JSON.parse(outputData);
  const parsed = schema.parse(output);

  return parsed;
};

export * from './my-stack-output';
