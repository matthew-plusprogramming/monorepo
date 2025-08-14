import { loadCDKOutput } from '@cdk/monorepo-cdk';

const baseCdkOutputsPath = __BUNDLED__ ? '.' : undefined;

export const usersTableName = loadCDKOutput<'my-stack'>(
  'my-stack',
  baseCdkOutputsPath,
).userTableName;
