import { TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

import type { UniversalStackProps } from '../../types/stack';
import { StandardBackend } from '../../utils/standard-backend';

import { generateApiLambda } from './generate-api-lambda';

export type ApiLambdaStackProps = UniversalStackProps;

export class ApiLambdaStack extends TerraformStack {
  public constructor(scope: Construct, id: string, props: ApiLambdaStackProps) {
    super(scope, id);

    const { region } = props;

    new StandardBackend(this, id, region);

    generateApiLambda(this, region);
  }
}
