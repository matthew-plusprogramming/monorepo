import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch-log-group';
import { CloudwatchLogStream } from '@cdktf/provider-aws/lib/cloudwatch-log-stream';
import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import {
  USER_SCHEMA_CONSTANTS,
  VERIFICATION_SCHEMA_CONSTANTS,
} from '@packages/schemas/user';
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

    const verificationTable = new DynamodbTable(this, 'verification-table', {
      name: `${bucketName}-verification-table`,
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
    });

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

    new TerraformOutput(this, 'userTableName', {
      value: userTable.name,
      description: 'The name of the user table',
    });
    new TerraformOutput(this, 'verificationTableName', {
      value: verificationTable.name,
      description: 'The name of the verification table',
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
