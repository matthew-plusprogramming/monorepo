import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import { TerraformOutput } from 'cdktf';
import type { Construct } from 'constructs';

import { __ENTITY_CONSTANT___TABLE_NAME } from './__ENTITY_CAMEL__-table.constants';
// TODO: import schema constants from '@packages/schemas/__ENTITY_SLUG__' once defined.

export const generate__ENTITY_PASCAL__Table = (
  scope: Construct,
  region: string,
): void => {
  const table = new DynamodbTable(scope, __ENTITY_CONSTANT___TABLE_NAME, {
    name: __ENTITY_CONSTANT___TABLE_NAME,
    billingMode: 'PAY_PER_REQUEST',
    hashKey: 'TODO_REPLACE_HASH_KEY',
    /**
     * TODO: add attribute definitions, GSIs, TTL configuration, and streams according
     * to the repository-service workflow step 3.
     */
    attribute: [
      {
        name: 'TODO_REPLACE_HASH_KEY',
        type: 'S',
      },
    ],
    region,
  });

  new TerraformOutput(scope, '__ENTITY_CAMEL__TableName', {
    value: table.name,
    description: 'TODO: clarify how the application uses this table output.',
  });
};
