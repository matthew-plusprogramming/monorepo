import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import type { UniversalStackProps } from '@type/stack';
import { StandardBackend } from '@utils/standard-backend';
import { TerraformOutput, TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

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
