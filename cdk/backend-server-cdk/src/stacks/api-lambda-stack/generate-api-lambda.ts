import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { LambdaFunction } from '@cdktf/provider-aws/lib/lambda-function';
import { AssetType, TerraformAsset, Token } from 'cdktf';
import type { Construct } from 'constructs';
import { resolve } from 'path';

import { packageRootDir } from '../../location';

export const generateApiLambda = (scope: Construct, region: string): void => {
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
  // TODO: Implement aws_iam_role_policy_attachment
  const iamRole = new IamRole(scope, 'lambda_iam', {
    assumeRolePolicy: Token.asString(assumeRole.json),
    managedPolicyArns: [
      'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess_v2',
      'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    ],
    name: 'lambda_execution_role',
  });
  // TODO: Implement public URL

  const asset = new TerraformAsset(scope, 'lambda-asset', {
    path: resolve(packageRootDir, 'dist/lambda.zip'),
    type: AssetType.FILE,
  });

  // TODO: Move these constants (memory size, reserved concurrency, etc) to config
  new LambdaFunction(scope, 'my-lambda-function', {
    functionName: 'my-lambda-function',
    filename: asset.path,
    handler: 'lambda.handler',
    runtime: 'nodejs22.x',
    memorySize: 128,
    timeout: 10,
    environment: {},
    role: iamRole.arn,
    region,
  });
};
