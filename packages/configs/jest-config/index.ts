import type { Config } from 'jest';

const message =
  'Jest config has been replaced by @configs/vitest-config. Use its node/browser helpers instead.';

throw new Error(message);

export const nodeConfig: Config = {} as never;
export const browserConfig: Config = {} as never;
