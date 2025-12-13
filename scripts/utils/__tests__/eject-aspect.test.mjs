import assert from 'node:assert/strict';
import test from 'node:test';

import {
  removeHeartbeatFromServerIndex,
  stripAnalyticsFromNodeCdkOutputs,
  stripAnalyticsPermissionsFromApiLambda,
} from '../../aspects/analytics.aspect.mjs';

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

