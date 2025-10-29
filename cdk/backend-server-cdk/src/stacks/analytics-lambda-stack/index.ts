import { TerraformOutput, TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

import type { UniversalStackProps } from '../../types/stack';
import { StandardBackend } from '../../utils/standard-backend';

import { generateAnalyticsLambdaResources } from './generate-analytics-lambda-resources';

export type AnalyticsLambdaStackProps = UniversalStackProps;

export class AnalyticsLambdaStack extends TerraformStack {
  public constructor(
    scope: Construct,
    id: string,
    props: AnalyticsLambdaStackProps,
  ) {
    super(scope, id);

    const { region } = props;

    new StandardBackend(this, id, region);

    const { processorLambdaFunction, processorRule } =
      generateAnalyticsLambdaResources(this, region);

    new TerraformOutput(this, 'analyticsProcessorLambdaFunctionArn', {
      value: processorLambdaFunction.arn,
      description: 'ARN of the analytics EventBridge processor Lambda function',
    });
    new TerraformOutput(this, 'analyticsProcessorLambdaFunctionName', {
      value: processorLambdaFunction.functionName,
      description:
        'Name of the analytics EventBridge processor Lambda function',
    });
    new TerraformOutput(this, 'analyticsProcessorRuleArn', {
      value: processorRule.arn,
      description: 'ARN of the EventBridge rule routing analytics events',
    });
    new TerraformOutput(this, 'analyticsProcessorRuleName', {
      value: processorRule.name,
      description: 'Name of the EventBridge rule routing analytics events',
    });
  }
}
