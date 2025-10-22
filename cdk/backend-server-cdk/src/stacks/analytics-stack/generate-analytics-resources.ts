import { CloudwatchEventBus } from '@cdktf/provider-aws/lib/cloudwatch-event-bus';
import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch-log-group';
import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import { SqsQueue } from '@cdktf/provider-aws/lib/sqs-queue';
import type { Construct } from 'constructs';

import {
  ANALYTICS_AGGREGATE_TABLE_NAME,
  ANALYTICS_DEDUPE_TABLE_NAME,
  ANALYTICS_EVENT_BRIDGE_DLQ_NAME,
  ANALYTICS_EVENT_BUS_NAME,
  ANALYTICS_EVENT_INGESTION_LOG_GROUP_NAME,
  ANALYTICS_PROCESSOR_LOG_GROUP_NAME,
} from './constants';

export interface AnalyticsResources {
  eventBridgeBus: CloudwatchEventBus;
  eventBridgeDeadLetterQueue: SqsQueue;
  dedupeTable: DynamodbTable;
  metricsAggregateTable: DynamodbTable;
  eventIngestionLogGroup: CloudwatchLogGroup;
  processorLogGroup: CloudwatchLogGroup;
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

const createAnalyticsLogGroup = (
  scope: Construct,
  logGroupName: string,
): CloudwatchLogGroup =>
  new CloudwatchLogGroup(scope, logGroupName, {
    name: logGroupName,
    retentionInDays: 30,
  });

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
  const eventIngestionLogGroup = createAnalyticsLogGroup(
    scope,
    ANALYTICS_EVENT_INGESTION_LOG_GROUP_NAME,
  );
  const processorLogGroup = createAnalyticsLogGroup(
    scope,
    ANALYTICS_PROCESSOR_LOG_GROUP_NAME,
  );

  return {
    eventBridgeBus,
    eventBridgeDeadLetterQueue,
    dedupeTable,
    metricsAggregateTable,
    eventIngestionLogGroup,
    processorLogGroup,
  };
};
