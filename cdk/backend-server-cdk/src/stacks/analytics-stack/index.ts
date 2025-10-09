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
      eventBus,
      deadLetterQueue,
      dedupeTable,
      aggregateTable,
      eventLogGroup,
      processorLogGroup,
    } = generateAnalyticsResources(this, region);

    new TerraformOutput(this, 'eventBusArn', {
      value: eventBus.arn,
      description: 'ARN of the analytics EventBridge bus',
    });
    new TerraformOutput(this, 'eventBusName', {
      value: eventBus.name,
      description: 'Name of the analytics EventBridge bus',
    });
    new TerraformOutput(this, 'deadLetterQueueArn', {
      value: deadLetterQueue.arn,
      description: 'ARN of the analytics EventBridge DLQ',
    });
    new TerraformOutput(this, 'deadLetterQueueUrl', {
      value: deadLetterQueue.url,
      description: 'URL of the analytics EventBridge DLQ',
    });
    new TerraformOutput(this, 'dedupeTableName', {
      value: dedupeTable.name,
      description: 'Name of the DAU/MAU dedupe DynamoDB table',
    });
    new TerraformOutput(this, 'aggregateTableName', {
      value: aggregateTable.name,
      description: 'Name of the DAU/MAU aggregate DynamoDB table',
    });
    new TerraformOutput(this, 'eventLogGroupName', {
      value: eventLogGroup.name,
      description: 'CloudWatch log group for analytics event ingestion',
    });
    new TerraformOutput(this, 'processorLogGroupName', {
      value: processorLogGroup.name,
      description: 'CloudWatch log group for analytics processing Lambda',
    });
  }
}
