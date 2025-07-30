import type { Prettify } from '@utils/type-utils';
import type { TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';
import type z from 'zod';

export interface UniversalStackProps {
  region: string;
}

export interface Stack<TProps extends UniversalStackProps> {
  name: string;
  description?: string;
  Stack: new (scope: Construct, id: string, props: TProps) => TerraformStack;
  props: Omit<TProps, keyof UniversalStackProps>;
  outputSchema: z.ZodObject;
}

export type AnyStack = Prettify<Stack<UniversalStackProps>>;
