import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import {
  USER_SCHEMA_CONSTANTS,
  VERIFICATION_SCHEMA_CONSTANTS,
} from '@packages/schemas/user';
import { TerraformOutput } from 'cdktf';
import type { Construct } from 'constructs';

export const generateUserAndVerificationTable = (
  scope: Construct,
  region: string,
): void => {
  const userTable = new DynamodbTable(scope, 'user-table', {
    name: 'user-table',
    billingMode: 'PAY_PER_REQUEST',
    hashKey: USER_SCHEMA_CONSTANTS.key.id,
    attribute: [
      {
        name: USER_SCHEMA_CONSTANTS.key.id,
        type: 'S',
      },
      {
        name: USER_SCHEMA_CONSTANTS.key.email,
        type: 'S',
      },
    ],
    globalSecondaryIndex: [
      {
        name: USER_SCHEMA_CONSTANTS.gsi.email,
        hashKey: USER_SCHEMA_CONSTANTS.key.email,
        projectionType: 'ALL',
      },
    ],
    region,
  });

  const verificationTable = new DynamodbTable(
    scope,
    'user-verification-table',
    {
      name: `user-verification-table`,
      billingMode: 'PAY_PER_REQUEST',
      hashKey: VERIFICATION_SCHEMA_CONSTANTS.key.id,
      attribute: [
        {
          name: VERIFICATION_SCHEMA_CONSTANTS.key.id,
          type: 'S',
        },
      ],
      ttl: {
        attributeName: 'ttl',
        enabled: true,
      },
      region,
    },
  );

  new TerraformOutput(scope, 'userTableName', {
    value: userTable.name,
    description: 'The name of the user table',
  });
  new TerraformOutput(scope, 'verificationTableName', {
    value: verificationTable.name,
    description: 'The name of the verification table',
  });
};
