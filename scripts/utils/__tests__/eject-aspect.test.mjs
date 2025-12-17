import assert from 'node:assert/strict';
import test from 'node:test';

import {
  removeHeartbeatFromServerIndex,
  stripAnalyticsFromNodeCdkOutputs,
  stripAnalyticsPermissionsFromApiLambda,
} from '../../aspects/analytics.aspect.mjs';
import {
  removeUsersFromServerIndex,
  stripUserExportFromSchemasPackage,
  stripUserSchemaDependencyFromIsAuthenticatedMiddleware,
  stripUserTablesFromApiStackOutputSchema,
  stripUsersFromNodeCdkOutputs,
} from '../../aspects/users.aspect.mjs';

test('removeHeartbeatFromServerIndex strips heartbeat route and auth import', () => {
  const input = `import { getUserRequestHandler } from '@/handlers/getUser.handler';
import { heartbeatRequestHandler } from '@/handlers/heartbeat.handler';
import { loginRequestHandler } from '@/handlers/login.handler';
import { isAuthenticatedMiddlewareRequestHandler } from '@/middleware/isAuthenticated.middleware';

const app = express();
app.get(
  '/heartbeat',
  isAuthenticatedMiddlewareRequestHandler,
  heartbeatRequestHandler,
);
app.get('/user/:identifier', getUserRequestHandler);
`;

  const output = removeHeartbeatFromServerIndex(input);
  assert.ok(!output.includes('heartbeatRequestHandler'));
  assert.ok(!output.includes('/heartbeat'));
  assert.ok(!output.includes('isAuthenticatedMiddlewareRequestHandler'));
  assert.ok(output.includes("/user/:identifier"));
});

test('stripAnalyticsFromNodeCdkOutputs removes analytics loads/exports', () => {
  const input = `import {
  ANALYTICS_LAMBDA_STACK_NAME,
  ANALYTICS_STACK_NAME,
  API_STACK_NAME,
  loadCDKOutput,
} from '@cdk/platform-cdk';

const baseCdkOutputsPath = __BUNDLED__ ? '.' : undefined;

const apiOutput = loadCDKOutput<typeof API_STACK_NAME>(
  API_STACK_NAME,
  baseCdkOutputsPath,
);
export const usersTableName = apiOutput.apiUserTableName;

const analyticsOutput = loadCDKOutput<typeof ANALYTICS_STACK_NAME>(
  ANALYTICS_STACK_NAME,
  baseCdkOutputsPath,
);

export const analyticsEventBusArn = analyticsOutput.analyticsEventBusArn;
`;

  const output = stripAnalyticsFromNodeCdkOutputs(input);
  assert.ok(output.includes("import { API_STACK_NAME, loadCDKOutput }"));
  assert.ok(!output.includes('ANALYTICS_STACK_NAME'));
  assert.ok(!output.includes('analyticsOutput'));
  assert.ok(!output.includes('analyticsEventBusArn'));
});

test('stripAnalyticsPermissionsFromApiLambda removes analytics IAM policy', () => {
  const input = `import { DataAwsCallerIdentity } from '@cdktf/provider-aws/lib/data-aws-caller-identity';
import { IamPolicy } from '@cdktf/provider-aws/lib/iam-policy';
import { ANALYTICS_EVENT_BUS_NAME } from '../analytics-stack/constants';

const createAnalyticsPolicy = (
  scope: Construct,
  region: string,
  callerIdentity: DataAwsCallerIdentity,
): IamPolicy => {
  return {} as IamPolicy;
};

const createExecutionRole = (
  scope: Construct,
  assumeRole: DataAwsIamPolicyDocument,
  putEventsPolicy: IamPolicy,
): IamRole => {
  new IamRolePolicyAttachment(scope, 'attach-put-events-policy', {
    policyArn: putEventsPolicy.arn,
    role: 'role',
  });
  return {} as IamRole;
};

export const generateApiLambda = (scope: Construct, region: string): void => {
  const assumeRole = createAssumeRoleDocument(scope);
  const callerIdentity = new DataAwsCallerIdentity(scope, 'caller');
  const putEventsPolicy = createAnalyticsPolicy(scope, region, callerIdentity);
  const executionRole = createExecutionRole(scope, assumeRole, putEventsPolicy);
  void executionRole;
};
`;

  const output = stripAnalyticsPermissionsFromApiLambda(input);
  assert.ok(!output.includes('createAnalyticsPolicy'));
  assert.ok(!output.includes('ANALYTICS_EVENT_BUS_NAME'));
  assert.ok(!output.includes('putEventsPolicy'));
  assert.ok(output.includes('createExecutionRole(scope, assumeRole)'));
});

test('removeUsersFromServerIndex strips user handlers but keeps heartbeat route', () => {
  const input = `import { getUserRequestHandler } from '@/handlers/getUser.handler';
import { heartbeatRequestHandler } from '@/handlers/heartbeat.handler';
import { loginRequestHandler } from '@/handlers/login.handler';
import { registerRequestHandler } from '@/handlers/register.handler';
import { isAuthenticatedMiddlewareRequestHandler } from '@/middleware/isAuthenticated.middleware';

app.get(
  '/heartbeat',
  isAuthenticatedMiddlewareRequestHandler,
  heartbeatRequestHandler,
);
app.post('/register', registerRequestHandler);
app.post('/login', loginRequestHandler);
app.get('/user/:identifier', getUserRequestHandler);
`;

  const output = removeUsersFromServerIndex(input);
  assert.ok(!output.includes('getUserRequestHandler'));
  assert.ok(!output.includes('loginRequestHandler'));
  assert.ok(!output.includes('registerRequestHandler'));
  assert.ok(!output.includes("/register"));
  assert.ok(!output.includes("/login"));
  assert.ok(!output.includes("/user/:identifier"));
  assert.ok(output.includes('heartbeatRequestHandler'));
  assert.ok(output.includes("/heartbeat"));
  assert.ok(output.includes('isAuthenticatedMiddlewareRequestHandler'));
});

test('stripUsersFromNodeCdkOutputs removes user table export', () => {
  const input = `const apiOutput = loadCDKOutput<typeof API_STACK_NAME>(
  API_STACK_NAME,
  baseCdkOutputsPath,
);
export const usersTableName = apiOutput.apiUserTableName;
export const rateLimitTableName = apiOutput.apiRateLimitTableName;
export const denyListTableName = apiOutput.apiDenyListTableName;
`;

  const output = stripUsersFromNodeCdkOutputs(input);
  assert.ok(!output.includes('usersTableName'));
  assert.ok(output.includes('rateLimitTableName'));
  assert.ok(output.includes('denyListTableName'));
});

test('stripUserTablesFromApiStackOutputSchema removes user table outputs', () => {
  const input = `export const ApiStackOutputSchema = z.object({
  [API_STACK_NAME]: z.object({
    apiUserTableName: z.string(),
    apiUserVerificationTableName: z.string(),
    apiRateLimitTableName: z.string(),
    apiDenyListTableName: z.string(),
  }),
});
`;

  const output = stripUserTablesFromApiStackOutputSchema(input);
  assert.ok(!output.includes('apiUserTableName'));
  assert.ok(!output.includes('apiUserVerificationTableName'));
  assert.ok(output.includes('apiRateLimitTableName'));
  assert.ok(output.includes('apiDenyListTableName'));
});

test('stripUserExportFromSchemasPackage removes ./user export', () => {
  const input = JSON.stringify(
    {
      name: '@packages/schemas',
      exports: {
        './security': { import: './dist/security/index.js' },
        './user': { import: './dist/user/index.js' },
      },
    },
    null,
    2,
  );

  const output = stripUserExportFromSchemasPackage(input);
  assert.ok(output.includes('"./security"'));
  assert.ok(!output.includes('"./user"'));
});

test('stripUserSchemaDependencyFromIsAuthenticatedMiddleware inlines a local token schema', () => {
  const input = `import { UserTokenSchema } from '@packages/schemas/user';
import z from 'zod';

export const parseToken = (value) => UserTokenSchema.parse(value);
`;

  const output = stripUserSchemaDependencyFromIsAuthenticatedMiddleware(input);
  assert.ok(!output.includes("@packages/schemas/user"));
  assert.ok(output.includes('const UserTokenSchema = z'));
  assert.ok(output.includes('passthrough'));
});
