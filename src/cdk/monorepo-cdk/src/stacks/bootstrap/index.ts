import { DynamodbTable } from '@cdktf/provider-aws/lib/dynamodb-table';
import { AwsProvider } from '@cdktf/provider-aws/lib/provider';
import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import { S3BucketVersioningA } from '@cdktf/provider-aws/lib/s3-bucket-versioning';
import {
  BACKING_BUCKET_NAME,
  BACKING_LOCK_TABLE_NAME,
} from '@constants/backend';
import type { UniversalStackProps } from '@type/stack';
import { TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

export type BootstrapStackProps = UniversalStackProps;

export class BootstrapStack extends TerraformStack {
  public constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id);
    const { region } = props;

    new AwsProvider(this, 'AWS', {
      region,
    });

    new DynamodbTable(this, 'lock', {
      name: BACKING_LOCK_TABLE_NAME,
      billingMode: 'PAY_PER_REQUEST',
      hashKey: 'LockID',
      attribute: [
        {
          name: 'LockID',
          type: 'S',
        },
      ],
      region,
    });

    new S3Bucket(this, 'stateBucket', {
      bucket: BACKING_BUCKET_NAME,
      region,
    });

    new S3BucketVersioningA(this, 'stateBucketVersioning', {
      bucket: BACKING_BUCKET_NAME,
      versioningConfiguration: {
        status: 'Enabled',
      },
      region,
    });
  }
}
