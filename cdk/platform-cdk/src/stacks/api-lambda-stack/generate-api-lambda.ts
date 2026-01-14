import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch-log-group';
import { DataAwsCallerIdentity } from '@cdktf/provider-aws/lib/data-aws-caller-identity';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { IamPolicy } from '@cdktf/provider-aws/lib/iam-policy';
import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { IamRolePolicyAttachment } from '@cdktf/provider-aws/lib/iam-role-policy-attachment';
import { LambdaFunction } from '@cdktf/provider-aws/lib/lambda-function';
import { LambdaFunctionUrl } from '@cdktf/provider-aws/lib/lambda-function-url';
import { AssetType, TerraformAsset, TerraformOutput, Token } from 'cdktf';
import type { Construct } from 'constructs';

import {
  getLambdaArtifactDefinition,
  resolveZipPath,
} from '../../lambda/artifacts';
import { ANALYTICS_EVENT_BUS_NAME } from '../analytics-stack/constants';

import { API_LAMBDA_FUNCTION_NAME } from './constants';

const createAssumeRoleDocument = (scope: Construct): DataAwsIamPolicyDocument =>
  new DataAwsIamPolicyDocument(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-assume-role`,
    {
      statement: [
        {
          actions: ['sts:AssumeRole'],
          effect: 'Allow',
          principals: [
            {
              identifiers: ['lambda.amazonaws.com'],
              type: 'Service',
            },
          ],
        },
      ],
    },
  );

const createAnalyticsPolicy = (
  scope: Construct,
  region: string,
  callerIdentity: DataAwsCallerIdentity,
): IamPolicy => {
  const analyticsEventBusArn = `arn:aws:events:${region}:${Token.asString(
    callerIdentity.accountId,
  )}:event-bus/${ANALYTICS_EVENT_BUS_NAME}`;

  const eventBridgePolicyDocument = new DataAwsIamPolicyDocument(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-analytics-put-events-policy-document`,
    {
      version: '2012-10-17',
      statement: [
        {
          sid: 'VisualEditor0',
          effect: 'Allow',
          actions: ['events:PutEvents'],
          resources: [analyticsEventBusArn],
        },
      ],
    },
  );

  return new IamPolicy(scope, `${API_LAMBDA_FUNCTION_NAME}-put-events-policy`, {
    name: `${API_LAMBDA_FUNCTION_NAME}-put-events-policy`,
    policy: eventBridgePolicyDocument.json,
  });
};

const createExecutionRole = (
  scope: Construct,
  assumeRole: DataAwsIamPolicyDocument,
  putEventsPolicy: IamPolicy,
): IamRole => {
  const iamRole = new IamRole(scope, `${API_LAMBDA_FUNCTION_NAME}-role`, {
    name: `${API_LAMBDA_FUNCTION_NAME}-role`,
    assumeRolePolicy: Token.asString(assumeRole.json),
  });

  new IamRolePolicyAttachment(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-attach-execution-policy`,
    {
      policyArn:
        'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      role: iamRole.name,
    },
  );

  new IamRolePolicyAttachment(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-attach-dynamodb-policy`,
    {
      policyArn: 'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess_v2',
      role: iamRole.name,
    },
  );

  new IamRolePolicyAttachment(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-attach-put-events-policy`,
    {
      policyArn: putEventsPolicy.arn,
      role: iamRole.name,
    },
  );

  return iamRole;
};

const createLambdaResources = (
  scope: Construct,
  region: string,
  iamRole: IamRole,
): { lambdaFunction: LambdaFunction; lambdaUrl: LambdaFunctionUrl } => {
  const lambdaAssetPath = resolveZipPath(
    getLambdaArtifactDefinition('apiLambda'),
  );
  const asset = new TerraformAsset(scope, `${API_LAMBDA_FUNCTION_NAME}-asset`, {
    path: lambdaAssetPath,
    type: AssetType.FILE,
  });

  const lambdaLogGroup = new CloudwatchLogGroup(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-log-group`,
    {
      name: `/aws/lambda/${API_LAMBDA_FUNCTION_NAME}`,
      retentionInDays: 14,
    },
  );

  const lambdaFunction = new LambdaFunction(scope, API_LAMBDA_FUNCTION_NAME, {
    functionName: API_LAMBDA_FUNCTION_NAME,
    filename: asset.path,
    handler: 'lambda.handler',
    runtime: 'nodejs22.x',
    memorySize: 256,
    timeout: 10,
    environment: {
      variables: {
        JWT_SECRET: process.env.JWT_SECRET ?? '',
        PEPPER: process.env.PEPPER ?? '',
        APP_ENV: process.env.APP_ENV ?? '',
      },
    },
    role: iamRole.arn,
    region,
    loggingConfig: {
      logFormat: 'Text',
      logGroup: lambdaLogGroup.name,
    },
  });

  const lambdaUrl = new LambdaFunctionUrl(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-url`,
    {
      functionName: lambdaFunction.functionName,
      authorizationType: 'NONE',
    },
  );

  return { lambdaFunction, lambdaUrl };
};

export const generateApiLambda = (scope: Construct, region: string): void => {
  const assumeRole = createAssumeRoleDocument(scope);
  const callerIdentity = new DataAwsCallerIdentity(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-caller`,
  );
  const putEventsPolicy = createAnalyticsPolicy(scope, region, callerIdentity);
  const executionRole = createExecutionRole(scope, assumeRole, putEventsPolicy);
  const { lambdaUrl } = createLambdaResources(scope, region, executionRole);

  new TerraformOutput(scope, 'apiLambdaFunctionUrl', {
    value: lambdaUrl.functionUrl,
    description: 'The URL of the API Lambda function',
  });
};
