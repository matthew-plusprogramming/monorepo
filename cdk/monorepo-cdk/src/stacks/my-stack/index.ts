import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import { TerraformOutput, TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

import type { UniversalStackProps } from '../../types/stack';
import { StandardBackend } from '../../utils/standard-backend';

export interface MyStackProps extends UniversalStackProps {
  bucketName?: string;
}

export class MyStack extends TerraformStack {
  public constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id);

    const { bucketName, region } = props;

    new StandardBackend(this, id, region);

    const userTable = new DynamodbTable(this, 'user-table', {
      name: `${bucketName}-user-table`,
      billingMode: 'PAY_PER_REQUEST',
      hashKey: 'id',
      // TODO: Implement a way to generate these attributes from the schema
      attribute: [
        {
          name: 'id',
          type: 'S',
        },
        {
          name: 'email',
          type: 'S',
        },
      ],
      globalSecondaryIndex: [
        {
          name: 'email-index',
          hashKey: 'email',
          projectionType: 'ALL',
        },
      ],
      region,
    });

    const verificationTable = new DynamodbTable(this, 'verification-table', {
      name: `${bucketName}-verification-table`,
      billingMode: 'PAY_PER_REQUEST',
      hashKey: 'id',
      attribute: [
        {
          name: 'id',
          type: 'S',
        },
      ],
      ttl: {
        attributeName: 'ttl',
        enabled: true,
      },
      region,
    });

    new TerraformOutput(this, 'userTableName', {
      value: userTable.name,
      description: 'The name of the user table',
    });
    new TerraformOutput(this, 'verificationTableName', {
      value: verificationTable.name,
      description: 'The name of the verification table',
    });
  }
}
