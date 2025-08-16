import { loadCDKOutput } from '@cdk/backend-server-cdk';

const baseCdkOutputsPath = __BUNDLED__ ? '.' : undefined;

export const usersTableName = loadCDKOutput<'api-stack'>(
  'api-stack',
  baseCdkOutputsPath,
).userTableName;
