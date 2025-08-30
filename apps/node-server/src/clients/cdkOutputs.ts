import { loadCDKOutput } from '@cdk/backend-server-cdk';

const baseCdkOutputsPath = __BUNDLED__ ? '.' : undefined;

export const usersTableName = loadCDKOutput<'api-stack'>(
  'api-stack',
  baseCdkOutputsPath,
).userTableName;

export const applicationLogGroupName = loadCDKOutput<'api-stack'>(
  'api-stack',
  baseCdkOutputsPath,
).applicationLogGroupName;
export const serverLogStreamName = loadCDKOutput<'api-stack'>(
  'api-stack',
  baseCdkOutputsPath,
).serverLogStreamName;

export const securityLogGroupName = loadCDKOutput<'api-security-stack'>(
  'api-security-stack',
  baseCdkOutputsPath,
).securityLogGroupName;
export const securityLogStreamName = loadCDKOutput<'api-security-stack'>(
  'api-security-stack',
  baseCdkOutputsPath,
).securityLogStreamName;
export const rateLimitTableName = loadCDKOutput<'api-security-stack'>(
  'api-security-stack',
  baseCdkOutputsPath,
).rateLimitTableName;
export const denyListTableName = loadCDKOutput<'api-security-stack'>(
  'api-security-stack',
  baseCdkOutputsPath,
).denyListTableName;
