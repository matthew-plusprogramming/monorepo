import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import {
  DENY_LIST_SCHEMA_CONSTANTS,
  RATE_LIMITING_SCHEMA_CONSTANTS,
} from '@packages/schemas/security';
import { TerraformOutput } from 'cdktf';
import type { Construct } from 'constructs';

import { DENY_LIST_TABLE_NAME, RATE_LIMIT_TABLE_NAME } from './constants';

export const generateSecurityTables = (
  scope: Construct,
  region: string,
): void => {
  const rateLimitTable = new DynamodbTable(scope, RATE_LIMIT_TABLE_NAME, {
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

  const denyListTable = new DynamodbTable(scope, DENY_LIST_TABLE_NAME, {
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

  new TerraformOutput(scope, 'apiRateLimitTableName', {
    value: rateLimitTable.name,
    description: 'The name of the API rate limit table',
  });
  new TerraformOutput(scope, 'apiDenyListTableName', {
    value: denyListTable.name,
    description: 'The name of the API deny list table',
  });
};
