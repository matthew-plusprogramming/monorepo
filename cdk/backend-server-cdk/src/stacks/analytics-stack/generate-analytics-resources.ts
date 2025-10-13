import { CloudwatchEventBus } from '@cdktf/provider-aws/lib/cloudwatch-event-bus';
import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch-log-group';
import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import { SqsQueue } from '@cdktf/provider-aws/lib/sqs-queue';
import type { Construct } from 'constructs';

import {
  ANALYTICS_AGGREGATE_TABLE_NAME,
  ANALYTICS_DEDUPE_TABLE_NAME,
  ANALYTICS_EVENT_BUS_NAME,
} from './constants';

export interface AnalyticsResources {
  eventBus: CloudwatchEventBus;
  deadLetterQueue: SqsQueue;
  dedupeTable: DynamodbTable;
  aggregateTable: DynamodbTable;
  eventLogGroup: CloudwatchLogGroup;
  processorLogGroup: CloudwatchLogGroup;
}

export const generateAnalyticsResources = (
  scope: Construct,
  region: string,
): AnalyticsResources => {
  const deadLetterQueue = new SqsQueue(scope, 'analytics-metrics-dlq', {
    messageRetentionSeconds: 1_209_600, // 14 days
    sqsManagedSseEnabled: true,
    region,
  });

  const eventBus = new CloudwatchEventBus(scope, 'analytics-event-bus', {
    name: ANALYTICS_EVENT_BUS_NAME,
    description: 'EventBridge bus for DAU/MAU analytics ingestion',
    region,
    deadLetterConfig: {
      arn: deadLetterQueue.arn,
    },
  });

  const dedupeTable = new DynamodbTable(scope, 'analytics-dedupe-table', {
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

  const aggregateTable = new DynamodbTable(scope, 'analytics-aggregate-table', {
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

  const eventLogGroup = new CloudwatchLogGroup(scope, 'analytics-event-logs', {
    retentionInDays: 30,
  });

  const processorLogGroup = new CloudwatchLogGroup(
    scope,
    'analytics-processor-logs',
    {
      retentionInDays: 30,
    },
  );

  return {
    eventBus,
    deadLetterQueue,
    dedupeTable,
    aggregateTable,
    eventLogGroup,
    processorLogGroup,
  };
};
