import { TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

import type { UniversalStackProps } from '../../types/stack';
import { StandardBackend } from '../../utils/standard-backend';

import { generateSecurityTables } from './generate-security-tables';
import { generateUserAndVerificationTable } from './generate-user-and-verification-table';

export type ApiStackProps = UniversalStackProps;

export class ApiStack extends TerraformStack {
  public constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id);

    const { region } = props;

    new StandardBackend(this, id, region);

    generateUserAndVerificationTable(this, region);
    generateSecurityTables(this, region);
  }
}
