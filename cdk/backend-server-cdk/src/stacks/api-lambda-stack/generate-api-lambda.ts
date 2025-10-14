import { resolve } from 'node:path';

import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch-log-group';
import { DataAwsCallerIdentity } from '@cdktf/provider-aws/lib/data-aws-caller-identity';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { IamPolicy } from '@cdktf/provider-aws/lib/iam-policy';
import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { IamRolePolicyAttachment } from '@cdktf/provider-aws/lib/iam-role-policy-attachment';
import { LambdaFunction } from '@cdktf/provider-aws/lib/lambda-function';
import { AssetType, TerraformAsset, Token } from 'cdktf';
import type { Construct } from 'constructs';

import { packageRootDir } from '../../location';
import { ANALYTICS_EVENT_BUS_NAME } from '../analytics-stack/constants';

import { API_LAMBDA_FUNCTION_NAME } from './constants';

export const generateApiLambda = (scope: Construct, region: string): void => {
  const assumeRole = new DataAwsIamPolicyDocument(
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

  const callerIdentity = new DataAwsCallerIdentity(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-caller`,
  );
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

  const putEventsPolicy = new IamPolicy(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-put-events-policy`,
    {
      policy: eventBridgePolicyDocument.json,
    },
  );

  // TODO: Implement aws_iam_role_policy_attachment
  const iamRole = new IamRole(scope, `${API_LAMBDA_FUNCTION_NAME}-role`, {
    assumeRolePolicy: Token.asString(assumeRole.json),
    managedPolicyArns: [
      'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess_v2',
      'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
  });

  new IamRolePolicyAttachment(
    scope,
    `${API_LAMBDA_FUNCTION_NAME}-attach-put-events-policy`,
    {
      policyArn: putEventsPolicy.arn,
      role: iamRole.name,
    },
  );

  // TODO: Implement public URL
  const asset = new TerraformAsset(scope, `${API_LAMBDA_FUNCTION_NAME}-asset`, {
    path: resolve(packageRootDir, 'dist/lambda.zip'),
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

  // TODO: Move these constants (memory size, reserved concurrency, etc) to config
  // TODO: Set log group to application log group
  new LambdaFunction(scope, 'my-lambda-function', {
    functionName: API_LAMBDA_FUNCTION_NAME,
    filename: asset.path,
    handler: 'lambda.handler',
    runtime: 'nodejs22.x',
    memorySize: 256,
    timeout: 10,
    environment: {},
    role: iamRole.arn,
    region,
    loggingConfig: {
      logFormat: 'Text',
      logGroup: lambdaLogGroup.name,
    },
  });
};
