import { TerraformOutput, TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

import type { UniversalStackProps } from '../../types/stack';
import { StandardBackend } from '../../utils/standard-backend';

import { generateAnalyticsResources } from './generate-analytics-resources';

export type AnalyticsStackProps = UniversalStackProps;

export class AnalyticsStack extends TerraformStack {
  public constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id);

    const { region } = props;

    new StandardBackend(this, id, region);

    const {
      eventBridgeBus,
      eventBridgeDeadLetterQueue,
      dedupeTable,
      metricsAggregateTable,
      eventIngestionLogGroup,
      processorLogGroup,
    } = generateAnalyticsResources(this, region);

    new TerraformOutput(this, 'analyticsEventBusArn', {
      value: eventBridgeBus.arn,
      description: 'ARN of the analytics EventBridge bus',
    });
    new TerraformOutput(this, 'analyticsEventBusName', {
      value: eventBridgeBus.name,
      description: 'Name of the analytics EventBridge bus',
    });
    new TerraformOutput(this, 'analyticsEventBusDeadLetterQueueArn', {
      value: eventBridgeDeadLetterQueue.arn,
      description: 'ARN of the analytics EventBridge dead-letter queue',
    });
    new TerraformOutput(this, 'analyticsEventBusDeadLetterQueueUrl', {
      value: eventBridgeDeadLetterQueue.url,
      description: 'URL of the analytics EventBridge dead-letter queue',
    });
    new TerraformOutput(this, 'analyticsEventDedupeTableName', {
      value: dedupeTable.name,
      description: 'Name of the DAU/MAU dedupe DynamoDB table',
    });
    new TerraformOutput(this, 'analyticsMetricsAggregateTableName', {
      value: metricsAggregateTable.name,
      description: 'Name of the DAU/MAU aggregate DynamoDB table',
    });
    new TerraformOutput(this, 'analyticsEventIngestionLogGroupName', {
      value: eventIngestionLogGroup.name,
      description: 'CloudWatch log group for analytics event ingestion',
    });
    new TerraformOutput(this, 'analyticsProcessorLogGroupName', {
      value: processorLogGroup.name,
      description: 'CloudWatch log group for analytics processing Lambda',
    });
  }
}
