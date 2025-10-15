import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import {
  DENY_LIST_SCHEMA_CONSTANTS,
  RATE_LIMITING_SCHEMA_CONSTANTS,
} from '@packages/schemas/security';
import { TerraformOutput } from 'cdktf';
import type { Construct } from 'constructs';

import { DENY_LIST_TABLE_NAME, RATE_LIMIT_TABLE_NAME } from './constants';

// TODO: fold into the api stack (this shouldn't be separate)
export const generateSecurityTables = (
  scope: Construct,
  region: string,
): void => {
  const rateLimitTable = new DynamodbTable(scope, 'rate-limit-table', {
    name: RATE_LIMIT_TABLE_NAME,
    billingMode: 'PAY_PER_REQUEST',
    hashKey: RATE_LIMITING_SCHEMA_CONSTANTS.key.base,
    attribute: [
      {
        name: RATE_LIMITING_SCHEMA_CONSTANTS.key.base,
        type: 'S',
      },
    ],
    ttl: {
      attributeName: 'ttl',
      enabled: true,
    },
    region,
  });

  const denyListTable = new DynamodbTable(scope, 'deny-list-table', {
    name: DENY_LIST_TABLE_NAME,
    billingMode: 'PAY_PER_REQUEST',
    hashKey: DENY_LIST_SCHEMA_CONSTANTS.key.base,
    attribute: [
      {
        name: DENY_LIST_SCHEMA_CONSTANTS.key.base,
        type: 'S',
      },
    ],
    ttl: {
      attributeName: 'ttl',
      enabled: true,
    },
    region,
  });

  new TerraformOutput(scope, 'rateLimitTableName', {
    value: rateLimitTable.name,
    description: 'The name of the rate limit table',
  });
  new TerraformOutput(scope, 'denyListTableName', {
    value: denyListTable.name,
    description: 'The name of the deny list table',
  });
};
