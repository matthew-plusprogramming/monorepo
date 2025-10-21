import type { Config } from 'jest';

const message =
  'Jest config has been replaced by @configs/vitest-config. Use its node/browser helpers instead.';

throw new Error(message);

const createConfig = (): never => {
  throw new Error(message);
};

export const nodeConfig: Config = createConfig();
export const browserConfig: Config = createConfig();
