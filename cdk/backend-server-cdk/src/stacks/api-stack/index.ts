import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch-log-group';
import { CloudwatchLogStream } from '@cdktf/provider-aws/lib/cloudwatch-log-stream';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { LambdaFunction } from '@cdktf/provider-aws/lib/lambda-function';
import {
  AssetType,
  TerraformAsset,
  TerraformOutput,
  TerraformStack,
  Token,
} from 'cdktf';
import type { Construct } from 'constructs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { UniversalStackProps } from '../../types/stack';
import { StandardBackend } from '../../utils/standard-backend';

import { generateUserAndVerificationTable } from './generate-user-and-verification-table';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type ApiStackProps = UniversalStackProps;

const generate = (scope: Construct) => {
  const assumeRole = new DataAwsIamPolicyDocument(scope, 'assume_role', {
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
  });
  const iamRole = new IamRole(scope, 'lambda_iam', {
    assumeRolePolicy: Token.asString(assumeRole.json),
    name: 'lambda_execution_role',
  });

  const asset = new TerraformAsset(scope, 'lambda-asset', {
    path: resolve(__dirname, '../../../dist/lambda.zip'),
    type: AssetType.FILE,
  });
  // TODO get this to work
  new LambdaFunction(scope, 'my-lambda-function', {
    functionName: 'my-lambda-function',
    filename: asset.path,
    handler: 'lambda.handler',
    runtime: 'nodejs22.x',
    memorySize: 128,
    timeout: 10,
    environment: {},
    role: iamRole.arn,
  });
};

export class ApiStack extends TerraformStack {
  public constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id);

    const { region } = props;

    new StandardBackend(this, id, region);

    generateUserAndVerificationTable(this, region);

    // TODO: see if I can get stack outputs BEFORE deploying
    // IF IT IS, I can totally make node-server rely on the outputs FIRST
    generate(this);

    const applicationLogGroup = new CloudwatchLogGroup(
      this,
      'application-logs',
      {
        name: 'application-logs',
      },
    );

    const serverLogStream = new CloudwatchLogStream(this, 'server-logs', {
      name: 'server-logs',
      logGroupName: applicationLogGroup.name,
    });

    new TerraformOutput(this, 'applicationLogGroupName', {
      value: applicationLogGroup.name,
      description: 'The name of the application log group',
    });
    new TerraformOutput(this, 'serverLogStreamName', {
      value: serverLogStream.name,
      description: 'The name of the server log stream',
    });
  }
}
