import { resolve } from 'node:path';

import { CloudwatchEventBus } from '@cdktf/provider-aws/lib/cloudwatch-event-bus';
import { CloudwatchEventRule } from '@cdktf/provider-aws/lib/cloudwatch-event-rule';
import { CloudwatchEventTarget } from '@cdktf/provider-aws/lib/cloudwatch-event-target';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import { IamPolicy } from '@cdktf/provider-aws/lib/iam-policy';
import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { IamRolePolicyAttachment } from '@cdktf/provider-aws/lib/iam-role-policy-attachment';
import { LambdaFunction } from '@cdktf/provider-aws/lib/lambda-function';
import { LambdaPermission } from '@cdktf/provider-aws/lib/lambda-permission';
import { SqsQueue } from '@cdktf/provider-aws/lib/sqs-queue';
import { AssetType, TerraformAsset, Token } from 'cdktf';
import type { Construct } from 'constructs';

import { packageRootDir } from '../../location';

import {
  ANALYTICS_AGGREGATE_TABLE_NAME,
  ANALYTICS_DEDUPE_TABLE_NAME,
  ANALYTICS_EVENT_BRIDGE_DLQ_NAME,
  ANALYTICS_EVENT_BUS_NAME,
  ANALYTICS_PROCESSOR_FUNCTION_NAME,
  ANALYTICS_PROCESSOR_RULE_NAME,
} from './constants';

export interface AnalyticsResources {
  eventBridgeBus: CloudwatchEventBus;
  eventBridgeDeadLetterQueue: SqsQueue;
  dedupeTable: DynamodbTable;
  metricsAggregateTable: DynamodbTable;
  processorLambdaFunction: LambdaFunction;
  processorRule: CloudwatchEventRule;
}

const createEventBridgeDeadLetterQueue = (
  scope: Construct,
  region: string,
): SqsQueue =>
  new SqsQueue(scope, ANALYTICS_EVENT_BRIDGE_DLQ_NAME, {
    name: ANALYTICS_EVENT_BRIDGE_DLQ_NAME,
    messageRetentionSeconds: 1_209_600, // 14 days
    sqsManagedSseEnabled: true,
    region,
  });

const createEventBridgeBus = (
  scope: Construct,
  region: string,
  deadLetterArn: string,
): CloudwatchEventBus =>
  new CloudwatchEventBus(scope, ANALYTICS_EVENT_BUS_NAME, {
    name: ANALYTICS_EVENT_BUS_NAME,
    description: 'EventBridge bus for DAU/MAU analytics ingestion',
    region,
    deadLetterConfig: {
      arn: deadLetterArn,
    },
  });

const createDedupeTable = (scope: Construct, region: string): DynamodbTable =>
  new DynamodbTable(scope, ANALYTICS_DEDUPE_TABLE_NAME, {
    name: ANALYTICS_DEDUPE_TABLE_NAME,
    billingMode: 'PAY_PER_REQUEST',
    hashKey: 'pk',
    attribute: [
      {
        name: 'pk',
        type: 'S',
      },
    ],
    ttl: {
      attributeName: 'expiresAt',
      enabled: true,
    },
    region,
  });

const createMetricsAggregateTable = (
  scope: Construct,
  region: string,
): DynamodbTable =>
  new DynamodbTable(scope, ANALYTICS_AGGREGATE_TABLE_NAME, {
    name: ANALYTICS_AGGREGATE_TABLE_NAME,
    billingMode: 'PAY_PER_REQUEST',
    hashKey: 'pk',
    attribute: [
      {
        name: 'pk',
        type: 'S',
      },
    ],
    region,
  });

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
  dedupeTable: DynamodbTable,
  metricsAggregateTable: DynamodbTable,
): IamPolicy => {
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
            dedupeTable.arn,
            `${dedupeTable.arn}/index/*`,
            metricsAggregateTable.arn,
            `${metricsAggregateTable.arn}/index/*`,
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
  const asset = new TerraformAsset(
    scope,
    `${ANALYTICS_PROCESSOR_FUNCTION_NAME}-asset`,
    {
      path: resolve(packageRootDir, 'dist/analytics-processor-lambda.zip'),
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
  eventBridgeBus: CloudwatchEventBus,
  processorLambda: LambdaFunction,
): CloudwatchEventRule => {
  const rule = new CloudwatchEventRule(scope, ANALYTICS_PROCESSOR_RULE_NAME, {
    name: ANALYTICS_PROCESSOR_RULE_NAME,
    description: 'Routes analytics ingestion events to the processor Lambda',
    eventBusName: eventBridgeBus.name,
    eventPattern: JSON.stringify({}),
    isEnabled: true,
    region,
  });

  new CloudwatchEventTarget(scope, `${ANALYTICS_PROCESSOR_RULE_NAME}-target`, {
    arn: processorLambda.arn,
    eventBusName: eventBridgeBus.name,
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

export const generateAnalyticsResources = (
  scope: Construct,
  region: string,
): AnalyticsResources => {
  const eventBridgeDeadLetterQueue = createEventBridgeDeadLetterQueue(
    scope,
    region,
  );
  const eventBridgeBus = createEventBridgeBus(
    scope,
    region,
    eventBridgeDeadLetterQueue.arn,
  );
  const dedupeTable = createDedupeTable(scope, region);
  const metricsAggregateTable = createMetricsAggregateTable(scope, region);
  const assumeRole = createAssumeRoleDocument(scope);
  const dynamoPolicy = createDynamoAccessPolicy(
    scope,
    dedupeTable,
    metricsAggregateTable,
  );
  const executionRole = createExecutionRole(scope, assumeRole, dynamoPolicy);
  const processorLambdaFunction = createProcessorLambda(
    scope,
    region,
    executionRole,
  );
  const processorRule = createProcessorRule(
    scope,
    region,
    eventBridgeBus,
    processorLambdaFunction,
  );

  return {
    eventBridgeBus,
    eventBridgeDeadLetterQueue,
    dedupeTable,
    metricsAggregateTable,
    processorLambdaFunction,
    processorRule,
  };
};
