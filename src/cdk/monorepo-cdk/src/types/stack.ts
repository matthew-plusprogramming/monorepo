import type { TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';

export interface UniversalStackProps {
  region: string;
}

export interface Stack<TProps extends UniversalStackProps> {
  name: string;
  description?: string;
  Stack: new (scope: Construct, id: string, props: TProps) => TerraformStack;
  props: Omit<TProps, keyof UniversalStackProps>;
}
