import type { Prettify } from '@utils/type-utils';
import type { TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';
import type z from 'zod';

import type { ArtifactRequirement } from '../lambda/artifacts';

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
  stages?: string[];
  requiredArtifacts?: ArtifactRequirement[];
}

export type AnyStack = Prettify<Stack<UniversalStackProps>>;
