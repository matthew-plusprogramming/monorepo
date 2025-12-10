import { AwsProvider } from '@cdktf/provider-aws/lib/provider';
import type { TerraformStack } from 'cdktf';
import { S3Backend } from 'cdktf';

import {
  BACKING_BUCKET_NAME,
  BACKING_LOCK_TABLE_NAME,
} from '../stacks/bootstrap/constants';

export class StandardBackend {
  public constructor(stack: TerraformStack, stackId: string, region: string) {
    // Automatically wires up the provider
    new AwsProvider(stack, 'AWS', { region });

    // And the S3 remote backend
    new S3Backend(stack, {
      bucket: BACKING_BUCKET_NAME,
      key: `stack/${stackId}/terraform.tfstate`,
      region,
      encrypt: true,
      dynamodbTable: BACKING_LOCK_TABLE_NAME,
    });
  }
}
