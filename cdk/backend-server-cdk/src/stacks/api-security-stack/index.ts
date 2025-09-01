import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch-log-group';
import { CloudwatchLogStream } from '@cdktf/provider-aws/lib/cloudwatch-log-stream';
import { TerraformOutput, TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

import type { UniversalStackProps } from '../../types/stack';
import { StandardBackend } from '../../utils/standard-backend';

import { generateSecurityTables } from './generate-security-tables';

export type ApiSecurityStackProps = UniversalStackProps;

export class ApiSecurityStack extends TerraformStack {
  public constructor(
    scope: Construct,
    id: string,
    props: ApiSecurityStackProps,
  ) {
    super(scope, id);

    const { region } = props;

    new StandardBackend(this, id, region);

    generateSecurityTables(this, region);

    // TODO: Set auto expiration
    const securityLogGroup = new CloudwatchLogGroup(this, 'security-logs', {
      name: 'security-logs',
    });

    const securityLogStream = new CloudwatchLogStream(
      this,
      'security-lambda-logs',
      {
        name: 'security-lambda-logs',
        logGroupName: securityLogGroup.name,
      },
    );

    new TerraformOutput(this, 'securityLogGroupName', {
      value: securityLogGroup.name,
      description: 'The name of the security log group',
    });
    new TerraformOutput(this, 'securityLogStreamName', {
      value: securityLogStream.name,
      description: 'The name of the security log stream',
    });
  }
}
