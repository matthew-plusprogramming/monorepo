import { TerraformStack } from 'cdktf';
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

  }
}
