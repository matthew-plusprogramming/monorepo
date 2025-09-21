import { resolve } from 'node:path';

import { nodeConfig } from '@configs/vitest-config';

export default nodeConfig({
  projectRoot: __dirname,
  srcDir: 'schemas',
  include: ['schemas/**/*.test.ts'],
  alias: {
    '@schemas': resolve(__dirname, 'schemas'),
  },
});
