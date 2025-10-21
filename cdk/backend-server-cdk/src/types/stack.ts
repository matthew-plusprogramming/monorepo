import type { Prettify } from '@utils/type-utils';
import type { TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';
import type z from 'zod';

export interface UniversalStackProps {
  region: string;
}

export interface Stack<
  TProps extends UniversalStackProps,
  TOutputSchema extends z.ZodType = z.ZodType,
> {
  name: string;
  description?: string;
  Stack: new (scope: Construct, id: string, props: TProps) => TerraformStack;
  props: Omit<TProps, keyof UniversalStackProps>;
  outputSchema: TOutputSchema;
}

export type AnyStack = Prettify<Stack<UniversalStackProps>>;
