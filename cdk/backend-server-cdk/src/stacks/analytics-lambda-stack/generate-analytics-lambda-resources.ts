import { CloudwatchEventRule } from '@cdktf/provider-aws/lib/cloudwatch-event-rule';
import { CloudwatchEventTarget } from '@cdktf/provider-aws/lib/cloudwatch-event-target';
import { DataAwsCallerIdentity } from '@cdktf/provider-aws/lib/data-aws-caller-identity';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { IamPolicy } from '@cdktf/provider-aws/lib/iam-policy';
import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { IamRolePolicyAttachment } from '@cdktf/provider-aws/lib/iam-role-policy-attachment';
import { LambdaFunction } from '@cdktf/provider-aws/lib/lambda-function';
import { LambdaPermission } from '@cdktf/provider-aws/lib/lambda-permission';
import { AssetType, TerraformAsset, Token } from 'cdktf';
import type { Construct } from 'constructs';

import {
  getLambdaArtifactDefinition,
  resolveZipPath,
} from '../../lambda/artifacts';
import {
  ANALYTICS_AGGREGATE_TABLE_NAME,
  ANALYTICS_DEDUPE_TABLE_NAME,
  ANALYTICS_EVENT_BUS_NAME,
  ANALYTICS_PROCESSOR_FUNCTION_NAME,
  ANALYTICS_PROCESSOR_RULE_NAME,
} from '../analytics-stack/constants';

export interface AnalyticsLambdaResources {
  processorLambdaFunction: LambdaFunction;
  processorRule: CloudwatchEventRule;
}

const createAssumeRoleDocument = (scope: Construct): DataAwsIamPolicyDocument =>
  new DataAwsIamPolicyDocument(
    scope,
    `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-assume-role`,
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

const createDynamoAccessPolicy = (
  scope: Construct,
  region: string,
  callerIdentity: DataAwsCallerIdentity,
): IamPolicy => {
  const accountId = Token.asString(callerIdentity.accountId);

  const dedupeTableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${ANALYTICS_DEDUPE_TABLE_NAME}`;
  const metricsAggregateTableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${ANALYTICS_AGGREGATE_TABLE_NAME}`;

  const policyDocument = new DataAwsIamPolicyDocument(
    scope,
    `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-dynamodb-policy-document`,
    {
      version: '2012-10-17',
      statement: [
        {
          sid: 'AnalyticsProcessorDynamoAccess',
          effect: 'Allow',
          actions: [
            'dynamodb:BatchGetItem',
            'dynamodb:BatchWriteItem',
            'dynamodb:DeleteItem',
            'dynamodb:DescribeTable',
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:Query',
            'dynamodb:Scan',
            'dynamodb:UpdateItem',
          ],
          resources: [
            dedupeTableArn,
            `${dedupeTableArn}/index/*`,
            metricsAggregateTableArn,
            `${metricsAggregateTableArn}/index/*`,
          ],
        },
      ],
    },
  );

  return new IamPolicy(
    scope,
    `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-dynamodb-policy`,
    {
      name: `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-dynamodb-policy`,
      policy: policyDocument.json,
    },
  );
};

const createExecutionRole = (
  scope: Construct,
  assumeRole: DataAwsIamPolicyDocument,
  dynamoPolicy: IamPolicy,
): IamRole => {
  const iamRole = new IamRole(
    scope,
    `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-role`,
    {
      name: `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-role`,
      assumeRolePolicy: Token.asString(assumeRole.json),
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      ],
    },
  );

  new IamRolePolicyAttachment(
    scope,
    `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-attach-dynamodb-policy`,
    {
      policyArn: dynamoPolicy.arn,
      role: iamRole.name,
    },
  );

  return iamRole;
};

const createProcessorLambda = (
  scope: Construct,
  region: string,
  iamRole: IamRole,
): LambdaFunction => {
  const artifactPath = resolveZipPath(
    getLambdaArtifactDefinition('analyticsProcessor'),
  );
  const asset = new TerraformAsset(
    scope,
    `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-asset`,
    {
      path: artifactPath,
      type: AssetType.FILE,
    },
  );

  return new LambdaFunction(scope, ANALYTICS_PROCESSOR_FUNCTION_NAME, {
    functionName: ANALYTICS_PROCESSOR_FUNCTION_NAME,
    filename: asset.path,
    handler: 'lambda.handler',
    runtime: 'nodejs22.x',
    memorySize: 256,
    timeout: 10,
    role: iamRole.arn,
    region,
  });
};

const createProcessorRule = (
  scope: Construct,
  region: string,
  processorLambda: LambdaFunction,
): CloudwatchEventRule => {
  const rule = new CloudwatchEventRule(scope, ANALYTICS_PROCESSOR_RULE_NAME, {
    name: ANALYTICS_PROCESSOR_RULE_NAME,
    description: 'Routes analytics ingestion events to the processor Lambda',
    eventBusName: ANALYTICS_EVENT_BUS_NAME,
    eventPattern: JSON.stringify({}),
    isEnabled: true,
    region,
  });

  new CloudwatchEventTarget(scope, `${ANALYTICS_PROCESSOR_RULE_NAME}-target`, {
    arn: processorLambda.arn,
    eventBusName: ANALYTICS_EVENT_BUS_NAME,
    rule: rule.name,
    targetId: `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-target`,
    region,
  });

  new LambdaPermission(
    scope,
    `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-allow-events`,
    {
      action: 'lambda:InvokeFunction',
      functionName: processorLambda.functionName,
      principal: 'events.amazonaws.com',
      sourceArn: rule.arn,
      region,
    },
  );

  return rule;
};

export const generateAnalyticsLambdaResources = (
  scope: Construct,
  region: string,
): AnalyticsLambdaResources => {
  const assumeRole = createAssumeRoleDocument(scope);
  const callerIdentity = new DataAwsCallerIdentity(
    scope,
    `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-caller`,
  );
  const dynamoPolicy = createDynamoAccessPolicy(scope, region, callerIdentity);
  const executionRole = createExecutionRole(scope, assumeRole, dynamoPolicy);
  const processorLambdaFunction = createProcessorLambda(
    scope,
    region,
    executionRole,
  );
  const processorRule = createProcessorRule(
    scope,
    region,
    processorLambdaFunction,
  );

  return {
    processorLambdaFunction,
    processorRule,
  };
};
