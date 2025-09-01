import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch-log-group';
import { CloudwatchLogStream } from '@cdktf/provider-aws/lib/cloudwatch-log-stream';
import { TerraformOutput, TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

import type { UniversalStackProps } from '../../types/stack';
import { StandardBackend } from '../../utils/standard-backend';

import { generateUserAndVerificationTable } from './generate-user-and-verification-table';

export type ApiStackProps = UniversalStackProps;

export class ApiStack extends TerraformStack {
  public constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id);

    const { region } = props;

    new StandardBackend(this, id, region);

    generateUserAndVerificationTable(this, region);

    const applicationLogGroup = new CloudwatchLogGroup(
      this,
      'application-logs',
      {
        name: 'application-logs',
      },
    );

    // TODO: Set auto expiration
    const serverLogStream = new CloudwatchLogStream(this, 'server-logs', {
      name: 'server-logs',
      logGroupName: applicationLogGroup.name,
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
