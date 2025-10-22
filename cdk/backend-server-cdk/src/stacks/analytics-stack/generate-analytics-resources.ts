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

export const generateAnalyticsResources = (
  scope: Construct,
  region: string,
): AnalyticsResources => {
  const eventBridgeDeadLetterQueue = new SqsQueue(
    scope,
    ANALYTICS_EVENT_BRIDGE_DLQ_NAME,
    {
      name: ANALYTICS_EVENT_BRIDGE_DLQ_NAME,
      messageRetentionSeconds: 1_209_600, // 14 days
      sqsManagedSseEnabled: true,
      region,
    },
  );

  const eventBridgeBus = new CloudwatchEventBus(
    scope,
    ANALYTICS_EVENT_BUS_NAME,
    {
      name: ANALYTICS_EVENT_BUS_NAME,
      description: 'EventBridge bus for DAU/MAU analytics ingestion',
      region,
      deadLetterConfig: {
        arn: eventBridgeDeadLetterQueue.arn,
      },
    },
  );

  const dedupeTable = new DynamodbTable(scope, ANALYTICS_DEDUPE_TABLE_NAME, {
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

  const metricsAggregateTable = new DynamodbTable(
    scope,
    ANALYTICS_AGGREGATE_TABLE_NAME,
    {
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
    },
  );

  const eventIngestionLogGroup = new CloudwatchLogGroup(
    scope,
    ANALYTICS_EVENT_INGESTION_LOG_GROUP_NAME,
    {
      name: ANALYTICS_EVENT_INGESTION_LOG_GROUP_NAME,
      retentionInDays: 30,
    },
  );

  const processorLogGroup = new CloudwatchLogGroup(
    scope,
    ANALYTICS_PROCESSOR_LOG_GROUP_NAME,
    {
      name: ANALYTICS_PROCESSOR_LOG_GROUP_NAME,
      retentionInDays: 30,
    },
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
