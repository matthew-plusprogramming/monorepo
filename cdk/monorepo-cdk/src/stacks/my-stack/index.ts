import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import type { UniversalStackProps } from '@type/stack';
import { StandardBackend } from '@utils/standard-backend';
import { TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

export interface MyStackProps extends UniversalStackProps {
  bucketName?: string;
}

export class MyStack extends TerraformStack {
  public constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id);

    const { bucketName, region } = props;

    new StandardBackend(this, id, region);

    new S3Bucket(this, 'bucket', {
      bucketPrefix: bucketName,
    });
  }
}
