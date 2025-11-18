import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import {
  USER_SCHEMA_CONSTANTS,
  VERIFICATION_SCHEMA_CONSTANTS,
} from '@packages/schemas/user';
import { TerraformOutput } from 'cdktf';
import type { Construct } from 'constructs';

import { USER_TABLE_NAME, USER_VERIFICATION_TABLE_NAME } from './constants';

export const generateUserAndVerificationTable = (
  scope: Construct,
  region: string,
): void => {
  const userTable = new DynamodbTable(scope, USER_TABLE_NAME, {
    name: USER_TABLE_NAME,
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
      {
        name: USER_SCHEMA_CONSTANTS.key.username,
        type: 'S',
      },
    ],
    globalSecondaryIndex: [
      {
        name: USER_SCHEMA_CONSTANTS.gsi.email,
        hashKey: USER_SCHEMA_CONSTANTS.key.email,
        projectionType: 'ALL',
      },
      {
        name: USER_SCHEMA_CONSTANTS.gsi.username,
        hashKey: USER_SCHEMA_CONSTANTS.key.username,
        projectionType: 'ALL',
      },
    ],
    region,
  });

  const verificationTable = new DynamodbTable(
    scope,
    USER_VERIFICATION_TABLE_NAME,
    {
      name: USER_VERIFICATION_TABLE_NAME,
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

  new TerraformOutput(scope, 'apiUserTableName', {
    value: userTable.name,
    description: 'The name of the API user table',
  });
  new TerraformOutput(scope, 'apiUserVerificationTableName', {
    value: verificationTable.name,
    description: 'The name of the API user verification table',
  });
};
